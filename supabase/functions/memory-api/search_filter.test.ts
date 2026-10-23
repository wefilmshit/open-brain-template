import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { buildTextSearchFilter, escapeLike } from "./search_filter.ts";

Deno.test("plain text filter is quoted", () => {
  assertEquals(buildTextSearchFilter("hello"), 'content.ilike."%hello%",summary.ilike."%hello%"');
});

Deno.test("PostgREST operators cannot add a top-level filter", () => {
  const filter = buildTextSearchFilter("a,id.not.is.null");
  let quoted = false;
  let escaped = false;
  let topLevelCommas = 0;
  for (const char of filter) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) topLevelCommas += 1;
  }
  assertEquals(topLevelCommas, 1);
});

Deno.test("500 seeded hostile strings remain one quoted pair", () => {
  const alphabet = [",", ".", "(", ")", '"', "\\", "%", "_", "*", ":", "a", "é", "1", " "];
  let seed = 0x0b1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const shape = /^content\.ilike\."(?:[^"\\]|\\.)*",summary\.ilike\."(?:[^"\\]|\\.)*"$/;
  for (let i = 0; i < 500; i += 1) {
    const length = 1 + Math.floor(random() * 80);
    let value = "";
    for (let j = 0; j < length; j += 1) value += alphabet[Math.floor(random() * alphabet.length)];
    assertMatch(buildTextSearchFilter(value), shape);
  }
});

Deno.test("LIKE wildcards are literal", () => {
  assertEquals(escapeLike("50%_off"), "50\\%\\_off");
});
