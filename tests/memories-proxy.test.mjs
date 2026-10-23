// Tests for the dashboard API proxy (api/memories.js + api/_auth.js).
// Run: npm test   (or: node --test "tests/*.test.mjs")
// No network: fetch is replaced by a recorder, so every test can show exactly
// which requests reached Supabase auth and which reached the memory API.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/memories.js";

const SUPABASE = "https://example-project.supabase.co";
const MEMORY_API = "https://example-project.supabase.co/functions/v1/memory-api";
const GOOD_TOKEN = "good-token";
const OTHER_TOKEN = "other-user-token";
const ID = "123e4567-e89b-42d3-a456-426614174000";

let calls;

function setEnv(overrides = {}) {
  const base = {
    DASHBOARD_SUPABASE_URL: SUPABASE,
    DASHBOARD_SUPABASE_ANON_KEY: "anon-key",
    DASHBOARD_ALLOWED_EMAILS: "Owner@Example.com, second@example.com",
    MEMORY_API_URL: MEMORY_API,
    MEMORY_API_KEY: "server-key",
  };
  for (const key of [...Object.keys(base), "SUPABASE_URL", "SUPABASE_ANON_KEY"]) delete process.env[key];
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  setEnv();
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    calls.push({ url: href, method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    if (href === `${SUPABASE}/auth/v1/user`) {
      const auth = opts.headers?.Authorization;
      if (auth === `Bearer ${GOOD_TOKEN}`) return jsonResponse(200, { id: "u1", email: "OWNER@example.com" });
      if (auth === `Bearer ${OTHER_TOKEN}`) return jsonResponse(200, { id: "u2", email: "stranger@example.com" });
      return jsonResponse(401, { msg: "invalid JWT" });
    }
    return jsonResponse(200, { ok: true });
  };
});

function makeReq({ method = "GET", path, token = GOOD_TOKEN, query = {}, body } = {}) {
  return {
    method,
    headers: token == null ? {} : { authorization: `Bearer ${token}` },
    query: path === undefined ? { ...query } : { path, ...query },
    body,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

async function call(reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

const memoryApiCalls = () => calls.filter((c) => c.url.startsWith(MEMORY_API));

test("no token: 401, nothing is called", async () => {
  const res = await call({ token: null });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("made-up token: Supabase says no, 401, memory API never reached", async () => {
  const res = await call({ token: "anything-at-all" });
  assert.equal(res.statusCode, 401);
  assert.equal(memoryApiCalls().length, 0);
  assert.equal(calls.length, 1, "only the Supabase auth check runs");
});

test("real login, email not on the server list: 403, memory API never reached", async () => {
  const res = await call({ token: OTHER_TOKEN });
  assert.equal(res.statusCode, 403);
  assert.equal(memoryApiCalls().length, 0);
});

test("allowed email matches regardless of letter case", async () => {
  const res = await call({ path: "recent" });
  assert.equal(res.statusCode, 200);
  assert.equal(memoryApiCalls().length, 1);
});

for (const [name, overrides] of [
  ["no Supabase URL", { DASHBOARD_SUPABASE_URL: undefined }],
  ["no anon key", { DASHBOARD_SUPABASE_ANON_KEY: undefined }],
  ["placeholder Supabase URL", { DASHBOARD_SUPABASE_URL: "YOUR_SUPABASE_URL" }],
  ["no allowed emails", { DASHBOARD_ALLOWED_EMAILS: undefined }],
  ["blank allowed emails", { DASHBOARD_ALLOWED_EMAILS: " , " }],
]) {
  test(`missing setting (${name}): fails closed with 503, nothing forwarded`, async () => {
    setEnv(overrides);
    const res = await call({ path: "recent" });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);
  });
}

test("missing memory API settings: 503 after auth, nothing forwarded", async () => {
  setEnv({ MEMORY_API_KEY: undefined });
  const res = await call({ path: "recent" });
  assert.equal(res.statusCode, 503);
  assert.equal(memoryApiCalls().length, 0);
});

test("plain-http memory API URL is refused (except localhost)", async () => {
  setEnv({ MEMORY_API_URL: "http://memory.example.com" });
  const res = await call({ path: "recent" });
  assert.equal(res.statusCode, 503);
  assert.equal(memoryApiCalls().length, 0);
});

for (const path of ["stats", "../admin", "recent/../../x", "add%2F..", "RECENT", "correct", "x".repeat(40)]) {
  test(`unlisted path ${JSON.stringify(path.slice(0, 20))}: 404, never reaches the memory API`, async () => {
    const res = await call({ path, method: "GET" });
    assert.equal(res.statusCode, 404);
    assert.equal(memoryApiCalls().length, 0);
  });
}

for (const [path, method] of [["recent", "DELETE"], ["recent", "POST"], ["add", "GET"], ["update", "POST"], ["delete", "GET"], ["search", "PUT"]]) {
  test(`wrong method ${method} on ${path}: 405, never reaches the memory API`, async () => {
    const res = await call({ path, method, body: { id: ID } });
    assert.equal(res.statusCode, 405);
    assert.equal(memoryApiCalls().length, 0);
  });
}

test("allowed calls go to the exact backend route with the server key", async () => {
  for (const [path, method] of [["recent", "GET"], ["search", "GET"], ["add", "POST"], ["update", "PUT"]]) {
    calls = [];
    const res = await call({ path, method, query: { limit: "5" }, body: method === "GET" ? undefined : { content: "x" } });
    assert.equal(res.statusCode, 200, `${method} ${path}`);
    const [m] = memoryApiCalls();
    assert.equal(new URL(m.url).pathname, `/functions/v1/memory-api/${path}`);
    assert.equal(m.method, method);
    assert.equal(m.headers["x-api-key"], "server-key");
  }
});

test("only known query params are forwarded", async () => {
  await call({ path: "recent", query: { limit: "10", category: "project", evil: "1", path2: "x" } });
  const u = new URL(memoryApiCalls()[0].url);
  assert.deepEqual([...u.searchParams.keys()].sort(), ["category", "limit"]);
});

test("delete by id goes to DELETE /<id> with no body", async () => {
  const res = await call({ path: "delete", method: "DELETE", body: { id: ID } });
  assert.equal(res.statusCode, 200);
  const [m] = memoryApiCalls();
  assert.equal(new URL(m.url).pathname, `/functions/v1/memory-api/${ID}`);
  assert.equal(m.method, "DELETE");
  assert.equal(m.body, undefined);
});

test("delete with a missing or malformed id: 400, never reaches the memory API", async () => {
  for (const body of [{}, { id: "not-a-uuid" }, { id: `${ID}/../stats` }]) {
    calls = [];
    const res = await call({ path: "delete", method: "DELETE", body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(memoryApiCalls().length, 0);
  }
});
