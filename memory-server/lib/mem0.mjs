// Optional Mem0 mirror. Inactive unless MEM0_API_KEY is set -- everything in
// this file is a no-op when Mem0 is not configured, matching the base
// contract's promise that Mem0 is a pairing, not a requirement.
//
// TRADE-OFF (read before enabling): every write here passes infer:false.
// Mem0's default behavior runs your text through an LLM extraction pass that
// rewrites it into Mem0's own "memory" phrasing and can auto-derive
// categories/tags. That is useful for some use cases, but it means what Mem0
// stores is NOT what you wrote -- and a memory_correct against a paraphrased
// mirror can drift further from the canonical row on every correction.
// infer:false makes Mem0 store your exact content/summary verbatim, at the
// cost of losing Mem0's auto-tagging and auto-categorization. If you want
// Mem0's inference, remove infer:false from mem0Add below -- but expect the
// mirror's text to diverge from what memory-api holds.
//
// Mem0 assigns its own id on creation. To find-and-delete/correct a mirror
// entry later, every add stamps metadata.canonical_memory_id with OUR row's
// id, and lookups filter Mem0's list response by that field client-side
// (Mem0's REST API does not expose delete-by-external-id).

const MEM0_BASE_URL = process.env.MEM0_BASE_URL || "https://api.mem0.ai";

export function buildMem0Client({ apiKey, userId }) {
  const enabled = Boolean(apiKey);
  if (!enabled) {
    return {
      enabled: false,
      add: async () => null,
      deleteByCanonicalId: async () => ({ deleted: 0 }),
    };
  }

  const resolvedUserId = userId || "default_user";

  async function mem0Fetch(path, options = {}) {
    const res = await fetch(`${MEM0_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiKey}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`mem0_request_failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    enabled: true,

    // Mirror a memory into Mem0. infer:false -> stored verbatim (see the
    // trade-off note at the top of this file).
    async add({ canonicalMemoryId, content, summary, category, tags }) {
      try {
        return await mem0Fetch("/v1/memories/", {
          method: "POST",
          body: JSON.stringify({
            messages: [{ role: "user", content: summary ? `${summary}\n\n${content}` : content }],
            user_id: resolvedUserId,
            infer: false,
            metadata: {
              canonical_memory_id: canonicalMemoryId,
              category: category || null,
              tags: tags || [],
            },
          }),
        });
      } catch (err) {
        console.error(`mem0 add failed (non-fatal): ${err.message}`);
        return null;
      }
    },

    // Find every Mem0 entry stamped with this canonical id and delete it.
    // Used by memory_archive (purge the mirror so an archived row stops
    // surfacing via Mem0-backed recall) and memory_correct (see the note in
    // server.mjs on why correct re-mirrors instead of editing in place).
    async deleteByCanonicalId(canonicalMemoryId) {
      try {
        const list = await mem0Fetch(`/v1/memories/?user_id=${encodeURIComponent(resolvedUserId)}`);
        const matches = (list?.results || list || []).filter(
          (entry) => entry?.metadata?.canonical_memory_id === canonicalMemoryId,
        );
        let deleted = 0;
        for (const entry of matches) {
          try {
            await mem0Fetch(`/v1/memories/${entry.id}/`, { method: "DELETE" });
            deleted += 1;
          } catch (err) {
            console.error(`mem0 delete failed for ${entry.id} (non-fatal): ${err.message}`);
          }
        }
        return { deleted };
      } catch (err) {
        console.error(`mem0 lookup failed (non-fatal): ${err.message}`);
        return { deleted: 0 };
      }
    },
  };
}
