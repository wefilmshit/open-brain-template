import { assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "https://fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-role");
Deno.env.set("MEMORY_API_KEY", "fixture-memory-key");

const handlerUrl = new URL("./index.ts", import.meta.url);
const source = await Deno.readTextFile(handlerUrl);
const marker = "Deno.serve(async (req) => {";
if (source.split(marker).length !== 2) throw new Error("Expected exactly one Deno.serve handler");
const testSource = source
  .replace('import { buildTextSearchFilter } from "./search_filter.ts";', `
function buildTextSearchFilter(q: string): string {
  return \`content.ilike."%\${q}%",summary.ilike."%\${q}%"\`;
}`)
  .replace('import { unsafeReasons } from "./write_safety.ts";', `
function unsafeReasons(_text: string): string[] {
  return [];
}`)
  .replace(marker, `
export const capturedHandler = async (req: Request) => {
`).replace(/\n\}\);\s*$/, "\n};\n");
const { capturedHandler: handle } = await import(`data:application/typescript,${encodeURIComponent(testSource)}`) as {
  capturedHandler: (req: Request) => Promise<Response>;
};

Deno.test("wrong key is 401 with a Bearer challenge", async () => {
  const response = await handle(new Request("https://fixture.invalid/memory-api/not-found", {
    headers: { Authorization: "Bearer wrong" },
  }));
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("www-authenticate"), 'Bearer realm="open-brain"');
});

Deno.test("lowercase bearer with the right key authenticates", async () => {
  const response = await handle(new Request("https://fixture.invalid/memory-api/not-found", {
    headers: { Authorization: "bearer fixture-memory-key" },
  }));
  assertEquals(response.status, 404);
});

Deno.test("unset origin allowlist sends no allow-origin header", async () => {
  Deno.env.delete("MEMORY_API_ALLOWED_ORIGINS");
  const response = await handle(new Request("https://fixture.invalid/memory-api", {
    method: "OPTIONS", headers: { Origin: "https://evil.example" },
  }));
  assertEquals(response.headers.get("access-control-allow-origin"), null);
});

Deno.test("named allowed origin is echoed", async () => {
  Deno.env.set("MEMORY_API_ALLOWED_ORIGINS", "https://a.example");
  try {
    const response = await handle(new Request("https://fixture.invalid/memory-api", {
      method: "OPTIONS", headers: { Origin: "https://a.example" },
    }));
    assertEquals(response.headers.get("access-control-allow-origin"), "https://a.example");
  } finally {
    Deno.env.delete("MEMORY_API_ALLOWED_ORIGINS");
  }
});
