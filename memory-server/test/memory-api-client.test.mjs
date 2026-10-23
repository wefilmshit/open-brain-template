import assert from "node:assert/strict";
import test from "node:test";
import { buildClient } from "../lib/memory-api-client.mjs";

const client = buildClient({
  apiUrl: "https://fixture.invalid/memory-api/",
  apiKey: "fixture-memory-key",
});

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("client sends the key as a Bearer token", async () => {
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = new Headers(init.headers);
    return response(200, { total: 0 });
  };
  await client.stats();
  assert.equal(seen.get("authorization"), "Bearer fixture-memory-key");
});

test("401 response is thrown with its status in the message", async () => {
  globalThis.fetch = async () => response(401, { error: "Unauthorized" });
  await assert.rejects(() => client.stats(), /401/);
});

test("429 response surfaces Retry-After", async () => {
  globalThis.fetch = async () => response(429, { error: "Too many requests" }, { "Retry-After": "17" });
  await assert.rejects(
    () => client.stats(),
    (error) => error.status === 429 && error.retryAfter === "17" && error.message.includes("429"),
  );
});

test("failed calls are never converted to an empty result", async () => {
  globalThis.fetch = async () => response(500, { error: "backend exploded" });
  await assert.rejects(() => client.recent(), /500/);
});
