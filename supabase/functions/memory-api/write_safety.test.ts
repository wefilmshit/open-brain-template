import { assertEquals } from "jsr:@std/assert@1";
import { unsafeReasons } from "./write_safety.ts";

const fixtures = JSON.parse(await Deno.readTextFile(new URL("./write-safety.fixtures.json", import.meta.url)));

Deno.test("write-safety fixtures retain the MCP reason contract", () => {
  for (const fixture of fixtures.unsafe) {
    assertEquals(unsafeReasons(fixture.text), fixture.reasons, fixture.reasons.join(","));
  }
  for (const text of fixtures.safe) {
    assertEquals(unsafeReasons(text), [], `safe fixture was flagged: ${text.slice(0, 80)}`);
  }
});

Deno.env.set("SUPABASE_URL", "https://fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-role");
Deno.env.set("MEMORY_API_KEY", "fixture-memory-key");
Deno.env.set("MEMORY_WRITE_SAFETY", "enforce");

let databaseCalls = 0;
(globalThis as Record<string, unknown>).__supabaseStub = {
  from() {
    databaseCalls += 1;
    throw new Error("database must not be called for an unsafe write");
  },
};

const handlerUrl = new URL("./index.ts", import.meta.url);
const writeSafetyUrl = new URL("./write_safety.ts", import.meta.url).href;
const source = await Deno.readTextFile(handlerUrl);
const marker = "Deno.serve(async (req) => {";
if (source.split(marker).length !== 2) throw new Error("Expected exactly one Deno.serve handler");
const testSource = source
  .replace(
    'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";',
    "const createClient = () => (globalThis as Record<string, unknown>).__supabaseStub as any;",
  )
  .replace('from "./write_safety.ts"', `from "${writeSafetyUrl}"`)
  .replace(marker, "export const capturedHandler = async (req: Request) => {")
  .replace(/\n\}\);\s*$/, "\n};\n");
const { capturedHandler: handle } = await import(`data:application/typescript,${encodeURIComponent(testSource)}`) as {
  capturedHandler: (req: Request) => Promise<Response>;
};

Deno.test("unsafe add is rejected before Supabase is called", async () => {
  databaseCalls = 0;
  const response = await handle(new Request("https://fixture.invalid/memory-api/add", {
    method: "POST",
    headers: {
      Authorization: "Bearer fixture-memory-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: "-----BEGIN PRIVATE\u0020KEY-----\nfake-only\n-----END PRIVATE\u0020KEY-----",
    }),
  }));
  assertEquals(response.status, 422);
  assertEquals(await response.json(), {
    error: "Unsafe memory content",
    code: "UNSAFE_CONTENT",
    reasons: ["secret:private_key"],
  });
  assertEquals(databaseCalls, 0);
});

const KEY_HEADERS = { Authorization: "Bearer fixture-memory-key", "Content-Type": "application/json" };
const UNSAFE = "-----BEGIN PRIVATE\u0020KEY-----\nfake-only\n-----END PRIVATE\u0020KEY-----";
const stub = (globalThis as Record<string, unknown>).__supabaseStub as Record<string, unknown>;
const refuseDatabase = stub.from;

Deno.test("unsafe text in the summary alone is refused", async () => {
  databaseCalls = 0;
  stub.from = refuseDatabase;
  const response = await handle(new Request("https://fixture.invalid/memory-api/add", {
    method: "POST",
    headers: KEY_HEADERS,
    body: JSON.stringify({ content: "an ordinary note", summary: UNSAFE }),
  }));
  assertEquals(response.status, 422);
  assertEquals(databaseCalls, 0);
});

Deno.test("/correct is checked like /add, not a way around enforce", async () => {
  databaseCalls = 0;
  stub.from = refuseDatabase;
  const response = await handle(new Request("https://fixture.invalid/memory-api/correct", {
    method: "POST",
    headers: KEY_HEADERS,
    body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", content: UNSAFE }),
  }));
  assertEquals(response.status, 422);
  assertEquals((await response.json()).code, "UNSAFE_CONTENT");
  assertEquals(databaseCalls, 0);
});

Deno.test("observe: an update without metadata leaves the row's metadata alone", async () => {
  Deno.env.set("MEMORY_WRITE_SAFETY", "observe");
  let written: Record<string, unknown> | undefined;
  const chain = {
    update(values: Record<string, unknown>) { written = values; return chain; },
    eq() { return chain; },
    select() { return chain; },
    single() { return Promise.resolve({ data: { id: "x" }, error: null }); },
  };
  stub.from = () => chain;
  try {
    const response = await handle(new Request("https://fixture.invalid/memory-api/update", {
      method: "PUT",
      headers: KEY_HEADERS,
      body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", content: UNSAFE }),
    }));
    assertEquals(response.status, 200);
    assertEquals(written?.content, UNSAFE);
    assertEquals("metadata" in (written || {}), false);
  } finally {
    Deno.env.set("MEMORY_WRITE_SAFETY", "enforce");
    stub.from = refuseDatabase;
  }
});
