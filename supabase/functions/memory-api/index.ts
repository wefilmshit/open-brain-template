// Open Brain memory-api — a generic, self-hostable Supabase Edge Function.
//
// Implements the base contract this repo's dashboard (index.html), Vercel
// proxy (api/memories.js), and Memory File Sync Kit (scripts/memory-sync/)
// already call, plus the fixes documented in docs/self-hosting-fixes.md:
//   - recall/search payload cap (top-K + byte budget)
//   - content-fingerprint dedup on write (update, not insert, on a match)
//   - a restorable archive shelf (archive/restore, not hard delete)
//   - remember() tolerance lives in memory-server (agent-facing ergonomics);
//     this edge function still requires content on /add for direct callers.
//   - exact /stats count (not a row-fetch cap presented as a total)
//
// Auth: every request must carry a matching x-api-key (or Bearer) header
// against the MEMORY_API_KEY secret. There is no tiered write-trust cap in
// this generic template -- any caller with a valid key may set any
// confirmation_status. See docs/self-hosting-fixes.md if you want one.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unsafeReasons } from "./write_safety.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MEMORY_API_KEY = Deno.env.get("MEMORY_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Recall/search payload cap ────────────────────────────────────────────
// Two independent limits, both applied: a hard cap on the NUMBER of rows
// returned (top-K), and a total-byte budget across the whole response. A
// single huge memory can still blow the byte budget even under the row cap,
// so content is truncated per-row once the running byte total would exceed
// the budget. This is what stops one recall call from returning a 60-80KB
// blob of full-content rows.
const RECALL_MAX_RESULTS = 6;
const RECALL_MAX_RESULTS_HARD = 10;
const RECALL_BYTE_BUDGET = 8192;
const RECALL_CONTENT_MAX_CHARS = 400;

const SEARCH_MAX_RESULTS = 50;

function capResults(
  rows: Record<string, unknown>[],
  { maxResults, byteBudget, contentMaxChars }: {
    maxResults: number;
    byteBudget?: number;
    contentMaxChars?: number;
  },
) {
  const capped = rows.slice(0, maxResults).map((row) => {
    if (!contentMaxChars) return row;
    const content = typeof row.content === "string" ? row.content : "";
    if (content.length <= contentMaxChars) return row;
    return {
      ...row,
      content: content.slice(0, contentMaxChars).trimEnd() + "…",
      content_truncated: true,
    };
  });

  if (!byteBudget) {
    return { results: capped, truncated_by_count: rows.length > maxResults, truncated_by_bytes: false };
  }

  let runningBytes = 0;
  const withinBudget: Record<string, unknown>[] = [];
  const encoder = new TextEncoder();
  for (const row of capped) {
    const size = encoder.encode(JSON.stringify(row)).length;
    if (runningBytes + size > byteBudget && withinBudget.length > 0) break;
    withinBudget.push(row);
    runningBytes += size;
  }

  return {
    results: withinBudget,
    truncated_by_count: rows.length > maxResults,
    truncated_by_bytes: withinBudget.length < capped.length,
    payload_bytes: runningBytes,
  };
}

// ── Content fingerprint (dedup-on-write) ────────────────────────────────
// content_fingerprint = sha256(content), lowercase hex. This is the ONLY
// dedup signal used -- byte-identity, never similarity or filename. See
// docs/self-hosting-fixes.md for why (a heuristic dedup destroys data;
// byte-identity is the only safe automatic signal).
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Helpers ──────────────────────────────────────────────────────────────
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aBytes = new Uint8Array(aDigest);
  const bBytes = new Uint8Array(bDigest);
  let difference = aBytes.length ^ bBytes.length;
  for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i += 1) {
    difference |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return difference === 0;
}

function corsOriginFor(origin: string | null, allowed: string[]): string | null {
  if (allowed.includes("*")) return "*";
  return origin && allowed.includes(origin) ? origin : null;
}

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("MEMORY_API_ALLOWED_ORIGINS") || "")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  const origin = corsOriginFor(req.headers.get("origin"), allowed);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    ...(allowed.length && !allowed.includes("*") ? { Vary: "Origin" } : {}),
  };
}

function json(req: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", ...extraHeaders },
  });
}

function errorResponse(
  req: Request,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return json(req, { error, ...extra }, status, headers);
}

async function requireAuth(req: Request): Promise<Response | null> {
  const key = req.headers.get("x-api-key") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key || !(await constantTimeEqual(key, MEMORY_API_KEY))) {
    return errorResponse(req, 401, "Unauthorized", {}, {
      "WWW-Authenticate": 'Bearer realm="open-brain"',
    });
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Checks the text a memory carries (content and summary together, as the MCP
// server does). Tags and metadata are not checked.
function writeSafety(content: unknown, summary: unknown, metadata: unknown) {
  const configured = (Deno.env.get("MEMORY_WRITE_SAFETY") || "enforce").toLowerCase();
  const mode = configured === "off" || configured === "observe" ? configured : "enforce";
  const text = [content, summary].filter((value): value is string => typeof value === "string").join("\n");
  const reasons = mode === "off" || !text ? [] : unsafeReasons(text);
  if (mode === "observe" && reasons.length) {
    console.warn("memory write safety observed", { reasons });
    // Tag only metadata the caller sent. An update without metadata must leave the
    // row's existing metadata alone, not replace it with { write_safety }.
    if (metadata === undefined) return { mode, reasons, metadata };
    return {
      mode,
      reasons,
      metadata: { ...((metadata && typeof metadata === "object") ? metadata : {}), write_safety: reasons },
    };
  }
  return { mode, reasons, metadata };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        ...corsHeaders(req),
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      },
    });
  }

  const authFailure = await requireAuth(req);
  if (authFailure) return authFailure;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/memory-api/, "") || "/";

  try {
    // ── ADD ────────────────────────────────────────────────────────────
    if (req.method === "POST" && path === "/add") {
      const body = await req.json();
      const { content, summary, category, source, tags, metadata, confirmation_status } = body;
      if (!content || typeof content !== "string") {
        return errorResponse(req, 400, "content is required");
      }

      const safety = writeSafety(content, summary, metadata ?? {});
      if (safety.mode === "enforce" && safety.reasons.length) {
        return errorResponse(req, 422, "Unsafe memory content", {
          code: "UNSAFE_CONTENT",
          reasons: safety.reasons,
        });
      }

      const fingerprint = await sha256Hex(content);

      // Dedup-on-write: an existing row with the SAME byte-identical content
      // gets updated (bumped updated_at, merged metadata/tags) instead of a
      // new row being inserted. This is a write-time guard, independent of
      // any application-level "upsert by filename" logic a caller does.
      const { data: existing } = await supabase
        .from("memories")
        .select("id, metadata, tags")
        .eq("content_fingerprint", fingerprint)
        .maybeSingle();

      if (existing) {
        const mergedMetadata = { ...(existing.metadata || {}), ...(safety.metadata || {}) };
        const mergedTags = Array.from(new Set([...(existing.tags || []), ...(tags || [])]));
        const { data, error } = await supabase
          .from("memories")
          .update({
            summary: summary ?? undefined,
            category: category ?? undefined,
            tags: mergedTags,
            metadata: mergedMetadata,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .select("id, summary, category, tags, metadata, created_at, updated_at")
          .single();
        if (error) throw error;
        return json(req, { success: true, memory: data, deduped: true });
      }

      const { data, error } = await supabase
        .from("memories")
        .insert({
          content,
          summary: summary ?? null,
          category: category || "general",
          source: source || "manual",
          tags: tags || [],
          metadata: safety.metadata || {},
          confirmation_status: confirmation_status || "evidence",
          content_fingerprint: fingerprint,
        })
        .select("id, summary, category, tags, metadata, created_at, updated_at")
        .single();
      if (error) throw error;
      return json(req, { success: true, memory: data });
    }

    // ── UPDATE ─────────────────────────────────────────────────────────
    if (req.method === "PUT" && path === "/update") {
      const body = await req.json();
      const { id, content, summary, category, tags, metadata, confirmation_status } = body;
      if (!id) return errorResponse(req, 400, "id is required");

      const safety = writeSafety(content, summary, metadata);
      if (safety.mode === "enforce" && safety.reasons.length) {
        return errorResponse(req, 422, "Unsafe memory content", {
          code: "UNSAFE_CONTENT",
          reasons: safety.reasons,
        });
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (content !== undefined) {
        updates.content = content;
        updates.content_fingerprint = await sha256Hex(content);
      }
      if (summary !== undefined) updates.summary = summary;
      if (category !== undefined) updates.category = category;
      if (tags !== undefined) updates.tags = tags;
      if (safety.metadata !== undefined) updates.metadata = safety.metadata;
      if (confirmation_status !== undefined) updates.confirmation_status = confirmation_status;

      const { data, error } = await supabase
        .from("memories")
        .update(updates)
        .eq("id", id)
        .select("id, summary, category, tags, metadata, created_at, updated_at")
        .single();
      if (error) throw error;
      if (!data) return errorResponse(req, 404, "not found");
      return json(req, { success: true, memory: data });
    }

    // ── CORRECT (audit-preserving update) ─────────────────────────────
    // Documented in docs/recall-quality.md Phase 4. Stashes the prior
    // content/summary into metadata.superseded_from, appends prior
    // supersessions to metadata.supersede_history, and updates in place
    // (never inserts a second row for a correction).
    if (req.method === "POST" && path === "/correct") {
      const body = await req.json();
      const { id, content, summary, reason } = body;
      if (!id) return errorResponse(req, 400, "id is required");
      if (content === undefined && summary === undefined) {
        return errorResponse(req, 400, "provide content or summary");
      }

      // Same write-safety check as /add and /update, so /correct is not a way around it.
      const safety = writeSafety(content, summary, undefined);
      if (safety.mode === "enforce" && safety.reasons.length) {
        return errorResponse(req, 422, "Unsafe memory content", {
          code: "UNSAFE_CONTENT",
          reasons: safety.reasons,
        });
      }

      const { data: existing } = await supabase
        .from("memories")
        .select("id, content, summary, metadata")
        .eq("id", id)
        .single();
      if (!existing) return errorResponse(req, 404, "not found");

      const meta = (existing.metadata || {}) as Record<string, unknown>;
      const priorHistory = Array.isArray(meta.supersede_history) ? meta.supersede_history as unknown[] : [];
      const priorSuperseded = meta.superseded_from;
      const newHistory = priorSuperseded ? [...priorHistory, priorSuperseded] : priorHistory;

      const newContent = content ?? existing.content;
      const newSummary = summary ?? existing.summary;
      const newMetadata = {
        ...meta,
        superseded_from: { content: existing.content, summary: existing.summary },
        supersede_reason: reason || null,
        superseded_at: new Date().toISOString(),
        supersede_history: newHistory,
        ...(safety.reasons.length ? { write_safety: safety.reasons } : {}),
      };

      const updates: Record<string, unknown> = { metadata: newMetadata, updated_at: new Date().toISOString() };
      if (content !== undefined) {
        updates.content = newContent;
        updates.content_fingerprint = await sha256Hex(newContent);
      }
      if (summary !== undefined) updates.summary = newSummary;

      const { data, error } = await supabase
        .from("memories")
        .update(updates)
        .eq("id", id)
        .select("id, summary, category, metadata, created_at, updated_at")
        .single();
      if (error) throw error;
      return json(req, { success: true, memory: data });
    }

    // ── ARCHIVE (restorable, not a hard delete) ───────────────────────
    if (req.method === "POST" && path.endsWith("/archive") && !path.startsWith("/archive")) {
      const id = path.split("/")[1];
      if (!id || !UUID_RE.test(id)) return errorResponse(req, 400, "invalid id");
      const body = await req.json().catch(() => ({}));
      const { data, error } = await supabase.rpc("archive_memory", {
        p_id: id,
        p_archived_by: body.archived_by || null,
        p_archive_reason: body.archive_reason || null,
      });
      if (error) {
        if (error.code === "P0002") return errorResponse(req, 404, "not found");
        throw error;
      }
      return json(req, { success: true, archived: { id: data.id, archived_at: data.archived_at, archive_reason: data.archive_reason } });
    }

    // ── RESTORE ────────────────────────────────────────────────────────
    if (req.method === "POST" && path.endsWith("/restore") && !path.startsWith("/restore")) {
      const id = path.split("/")[1];
      if (!id || !UUID_RE.test(id)) return errorResponse(req, 400, "invalid id");
      const { data, error } = await supabase.rpc("restore_memory", { p_id: id });
      if (error) {
        if (error.code === "P0002") return errorResponse(req, 404, "not found in archive");
        throw error;
      }
      return json(req, { success: true, restored: { id: data.id } });
    }

    // ── DELETE (two shapes: DELETE /delete {id in body}, DELETE /:id) ──
    if (req.method === "DELETE" && (path === "/delete" || path.match(/^\/[0-9a-f-]{36}$/i))) {
      let id: string | undefined;
      if (path === "/delete") {
        const body = await req.json().catch(() => ({}));
        id = body.id;
      } else {
        id = path.slice(1);
      }
      if (!id) return errorResponse(req, 400, "id is required");
      const { error } = await supabase.from("memories").delete().eq("id", id);
      if (error) throw error;
      return json(req, { success: true, deleted: id });
    }

    // ── RECENT ─────────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/recent") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 500);
      const category = url.searchParams.get("category");
      let query = supabase
        .from("memories")
        .select("id, content, summary, category, source, tags, metadata, confirmation_status, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (category) query = query.eq("category", category);
      const { data, error } = await query;
      if (error) throw error;
      return json(req, { memories: data });
    }

    // ── SEARCH (dashboard keyword search) ──────────────────────────────
    // Per README.md: dashboard search is intentionally keyword search
    // unless you wire and prove semantic search separately. This does a
    // literal, case-insensitive substring match over content and summary
    // (public.search_memories_text, migration 0003); no embedding call.
    if (req.method === "GET" && path === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const limit = Math.min(Number(url.searchParams.get("limit")) || SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS);
      if (!q) return errorResponse(req, 400, "query is required");

      // Literal substring match in SQL (migration 0003): no pattern syntax, so `*`, `%`,
      // `_` and every other character in q match only themselves.
      const { data, error } = await supabase.rpc("search_memories_text", { q, lim: limit });
      if (error) throw error;
      return json(req, { results: data, count: data.length });
    }

    // ── RECALL (agent-facing; capped top-K + byte budget) ──────────────
    // Optional bring-your-own-embedding: pass `embedding` (a number[]
    // matching the memories.embedding column dimension) for vector cosine
    // search. Without it, this falls back to the same keyword search as
    // /search. Either way, the RESPONSE is capped -- this is the fix for
    // the class of bug where a recall call returns 60-80KB of full rows.
    if (req.method === "POST" && path === "/recall") {
      const body = await req.json().catch(() => ({}));
      const query = (body.query || "").trim();
      const category = body.category || null;
      const requestedLimit = Math.min(Number(body.limit) || RECALL_MAX_RESULTS, RECALL_MAX_RESULTS_HARD);
      const embedding = Array.isArray(body.embedding) ? body.embedding : null;

      let rows: Record<string, unknown>[];
      if (embedding) {
        const { data, error } = await supabase.rpc("match_memories_basic", {
          query_embedding: embedding,
          match_count: RECALL_MAX_RESULTS_HARD,
          filter_category: category,
        });
        if (error) throw error;
        rows = data || [];
      } else {
        if (!query) return errorResponse(req, 400, "query is required (or pass embedding)");
        const { data, error } = await supabase.rpc("search_memories_text", {
          q: query,
          lim: RECALL_MAX_RESULTS_HARD,
          filter_category: category,
        });
        if (error) throw error;
        rows = data || [];
      }

      const capped = capResults(rows, {
        maxResults: requestedLimit,
        byteBudget: RECALL_BYTE_BUDGET,
        contentMaxChars: RECALL_CONTENT_MAX_CHARS,
      });
      return json(req, capped);
    }

    // ── STATS (exact count, not a row-fetch cap) ───────────────────────
    if (req.method === "GET" && path === "/stats") {
      const { count: exactTotal, error: countError } = await supabase
        .from("memories")
        .select("id", { count: "exact", head: true });
      if (countError) throw countError;

      const PAGE_SIZE = 1000;
      const rows: { category: string; source: string }[] = [];
      for (let from = 0;; from += PAGE_SIZE) {
        const { data: page, error: pageError } = await supabase
          .from("memories")
          .select("category, source")
          .range(from, from + PAGE_SIZE - 1);
        if (pageError) throw pageError;
        if (!page || page.length === 0) break;
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      const by_category: Record<string, number> = {};
      const by_source: Record<string, number> = {};
      for (const row of rows) {
        by_category[row.category] = (by_category[row.category] || 0) + 1;
        by_source[row.source] = (by_source[row.source] || 0) + 1;
      }

      return json(req, { total: exactTotal ?? rows.length, by_category, by_source });
    }

    return errorResponse(req, 404, "Not found", {
      routes: [
        "POST /add", "PUT /update", "POST /correct",
        "GET /recent", "GET /search", "POST /recall", "GET /stats",
        "DELETE /delete", "DELETE /:id",
        "POST /:id/archive", "POST /:id/restore",
      ],
    });
  } catch (err) {
    console.error("memory-api error", err);
    return errorResponse(req, 500, "Internal error", { message: (err as Error).message });
  }
});
