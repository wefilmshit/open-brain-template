#!/usr/bin/env node
// Open Brain memory-server -- a generic MCP server over the memory-api Edge
// Function. Stdio transport: works with Claude Code, Claude Desktop, Cursor,
// or any MCP-compatible client with zero separate hosting.
//
// Configuration (env vars, see .env.example):
//   MEMORY_API_URL    -- e.g. https://your-project.supabase.co/functions/v1/memory-api
//   MEMORY_API_KEY    -- must match the memory-api MEMORY_API_KEY secret
//   MEM0_API_KEY      -- optional; enables the Mem0 mirror (see lib/mem0.mjs)
//   MEM0_USER_ID      -- optional; defaults to "default_user"

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildClient } from "./lib/memory-api-client.mjs";
import { buildMem0Client } from "./lib/mem0.mjs";

const MEMORY_API_URL = process.env.MEMORY_API_URL;
const MEMORY_API_KEY = process.env.MEMORY_API_KEY;

if (!MEMORY_API_URL || !MEMORY_API_KEY) {
  console.error("MEMORY_API_URL and MEMORY_API_KEY are required. See .env.example.");
  process.exit(1);
}

const client = buildClient({ apiUrl: MEMORY_API_URL, apiKey: MEMORY_API_KEY });
const mem0 = buildMem0Client({ apiKey: process.env.MEM0_API_KEY, userId: process.env.MEM0_USER_ID });

// ── remember() tolerance: derive, never reject, never silent ──────────────
// A memory missing content AND summary is rejected (nothing to derive from).
// Missing exactly one is derived from the other, and the derivation is
// FLAGGED (metadata.summary_derived / content_derived), never silent. A
// derived summary presented as if hand-written is a destroyed signal that
// looks intact -- especially once recall caps content and returns the
// summary in full. See README.md / docs/self-hosting-fixes.md.
function deriveSummaryFromContent(content, maxChars = 180) {
  const flat = String(content ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return flat.slice(0, maxChars - 1).trimEnd() + "…";
}

const server = new Server(
  { name: "open-brain-memory-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "remember",
      description:
        "Store a new memory. Always include a short summary. If you omit the summary it is " +
        "derived from content (and flagged metadata.summary_derived); if you omit content the " +
        "summary is used as content. A write is never rejected for missing one of them -- but a " +
        "hand-written summary is always better than a derived one. At least one is required.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Full memory content. Required unless summary is given." },
          summary: { type: "string", description: "Brief 1-2 sentence summary. Derived from content if omitted." },
          category: { type: "string", description: "Category for organization (e.g. general, project, reference)." },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for filtering." },
          confirmation_status: { type: "string", description: "Optional trust label (e.g. evidence, confirmed)." },
          metadata: { type: "object", description: "Optional free-form metadata." },
        },
      },
    },
    {
      name: "recall",
      description:
        "Search memory and return a capped, size-bounded result set (top-K + byte budget). " +
        "Pass an embedding array for vector search if you have wired an embedding provider; " +
        "otherwise this does keyword search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text." },
          category: { type: "string", description: "Optional category filter." },
          limit: { type: "number", description: "Max results (capped server-side regardless)." },
          embedding: { type: "array", items: { type: "number" }, description: "Optional precomputed embedding vector." },
        },
      },
    },
    {
      name: "recent_memories",
      description: "List the most recent memories, optionally filtered by category.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 20)." },
          category: { type: "string", description: "Optional category filter." },
        },
      },
    },
    {
      name: "forget",
      description: "Permanently delete a memory by id. For a reversible removal, use memory_archive instead.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "UUID of the memory to delete." } },
        required: ["id"],
      },
    },
    {
      name: "memory_correct",
      description:
        "Update a memory IN PLACE, preserving the prior content/summary in metadata.supersede_history " +
        "(never a second row). If a Mem0 mirror is enabled, its copy is re-mirrored with the corrected text.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "UUID of the memory to correct." },
          content: { type: "string", description: "New content (omit to keep existing)." },
          summary: { type: "string", description: "New summary (omit to keep existing)." },
          reason: { type: "string", description: "Why this correction is being made." },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_archive",
      description:
        "Move a memory to the restorable archive shelf instead of deleting it. If a Mem0 mirror is " +
        "enabled, its copy is purged so recall stops surfacing the archived row. Reversible via memory_restore.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "UUID of the memory to archive." },
          reason: { type: "string", description: "Optional reason, stored on the archive row." },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_restore",
      description: "Restore a memory from the archive shelf back into the live store.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "UUID of the archived memory to restore." } },
        required: ["id"],
      },
    },
    {
      name: "memory_stats",
      description: "Return the exact total memory count plus a breakdown by category and source.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "remember": {
        let content = args.content;
        let summary = args.summary;
        if (!content && !summary) {
          return errorResult("provide content or summary (at least one is required)");
        }
        const contentDerived = !content;
        const summaryDerived = !summary;
        if (contentDerived) content = summary;
        if (summaryDerived) summary = deriveSummaryFromContent(content);

        const metadata = { ...(args.metadata || {}) };
        if (summaryDerived) metadata.summary_derived = true;
        if (contentDerived) metadata.content_derived = true;

        const result = await client.add({
          content,
          summary,
          category: args.category,
          tags: args.tags,
          metadata,
          confirmation_status: args.confirmation_status,
        });

        if (mem0.enabled && result?.memory?.id) {
          await mem0.add({
            canonicalMemoryId: result.memory.id,
            content,
            summary,
            category: args.category,
            tags: args.tags,
          });
        }
        return textResult(result);
      }

      case "recall": {
        const result = await client.recall({
          query: args.query,
          category: args.category,
          limit: args.limit,
          embedding: args.embedding,
        });
        return textResult(result);
      }

      case "recent_memories": {
        const result = await client.recent({ limit: args.limit, category: args.category });
        return textResult(result);
      }

      case "forget": {
        if (!args.id) return errorResult("id is required");
        const result = await client.deleteById(args.id);
        if (mem0.enabled) {
          const mem0Del = await mem0.deleteByCanonicalId(args.id);
          if (mem0Del.deleted) result.mem0_deleted = mem0Del.deleted;
        }
        return textResult(result);
      }

      case "memory_correct": {
        if (!args.id) return errorResult("id is required");
        if (args.content === undefined && args.summary === undefined) {
          return errorResult("provide content or summary");
        }
        const result = await client.correct({
          id: args.id,
          content: args.content,
          summary: args.summary,
          reason: args.reason,
        });

        // Mem0 correct-sync: re-mirror with the corrected text (infer:false,
        // exact storage). This is delete-then-readd against Mem0 rather than
        // an in-place Mem0 edit, because Mem0's REST API does not expose a
        // reliable "update by external id" path -- the find-then-delete
        // lookup in lib/mem0.mjs is the same mechanism forget() uses. Without
        // this, a corrected memory's Mem0 mirror keeps serving the OLD text.
        if (mem0.enabled && result?.memory) {
          await mem0.deleteByCanonicalId(args.id);
          await mem0.add({
            canonicalMemoryId: args.id,
            content: args.content ?? result.memory.summary,
            summary: result.memory.summary,
            category: result.memory.category,
          });
        }
        return textResult(result);
      }

      case "memory_archive": {
        if (!args.id) return errorResult("id is required");
        const result = await client.archive(args.id, { archived_by: "mcp", archive_reason: args.reason });
        let mem0Deleted = 0;
        if (mem0.enabled) {
          const mem0Del = await mem0.deleteByCanonicalId(args.id);
          mem0Deleted = mem0Del.deleted;
        }
        // Quiet response: never echo the embedding vector -- only the small
        // confirmation fields. See docs/self-hosting-fixes.md.
        return textResult({
          success: result?.success ?? true,
          archived_id: result?.archived?.id ?? args.id,
          archived_at: result?.archived?.archived_at ?? null,
          archive_reason: result?.archived?.archive_reason ?? args.reason ?? null,
          mem0_deleted: mem0Deleted,
        });
      }

      case "memory_restore": {
        if (!args.id) return errorResult("id is required");
        const result = await client.restore(args.id);
        return textResult({
          success: result?.success ?? true,
          restored_id: result?.restored?.id ?? args.id,
        });
      }

      case "memory_stats": {
        const result = await client.stats();
        return textResult(result);
      }

      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
});

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("open-brain-memory-server running on stdio");
