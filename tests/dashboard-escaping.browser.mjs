// Browser check: memory fields written by agents must render as text, never as HTML.
//
// Loads the real index.html in headless Chromium with every network request
// stubbed (no Supabase, no memory API), feeds crafted memories to each place
// the page renders a category, source or file type, and fails if any of them
// creates an element or runs script.
//
// Needs Playwright, which this repo does not install:
//   npm i --no-save playwright && npx playwright install chromium
//   node tests/dashboard-escaping.browser.mjs
// Set PLAYWRIGHT_MODULE to load a different copy, and CHROMIUM_PATH to use an
// already-downloaded browser.

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const page_url = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.html")).href;

const MARK = "window.__pwned=(window.__pwned||0)+1";
const EVIL = {
  tag: `<img src=x onerror="${MARK}">`,
  attr: `x"><img src=x onerror="${MARK}">`,
};

const SUPABASE_STUB = `
  window.supabase = { createClient: () => ({ auth: {
    getSession: async () => ({ data: { session: null } }),
    setSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({}), signInWithOAuth: async () => ({}),
  } }) };`;

function evilMemory(i) {
  return {
    id: `00000000-0000-4000-8000-00000000000${i}`,
    category: i % 2 ? EVIL.attr : EVIL.tag,
    source: EVIL.tag,
    summary: "summary",
    content: "content",
    tags: [],
    created_at: new Date().toISOString(),
    metadata: { file_type: EVIL.attr, file_name: "f.md", name: "f" },
  };
}

const checks = {
  // Search results: category (text and class) and source.
  "search results (category, source)": async (page) => {
    await page.evaluate((mems) => {
      window.api = async () => ({ results: mems });
      document.getElementById("bm-search-input").value = "anything";
      return bmSearch();
    }, [evilMemory(1), evilMemory(2)]);
    return "#bm-search-list";
  },
  // Brain map leaf: source.
  "brain map leaf (source)": async (page) => {
    await page.evaluate((m) => {
      const host = document.createElement("div");
      host.id = "leaf-host";
      host.innerHTML = bmRenderLeaf(m);
      document.body.appendChild(host);
    }, evilMemory(3));
    return "#leaf-host";
  },
  // Brain map legend: category name, on every tree load.
  "brain map legend (category)": async (page) => {
    await page.evaluate((mems) => {
      window.api = async () => ({ memories: mems });
      return loadTree();
    }, [evilMemory(4), evilMemory(5)]);
    return "#bm-dots";
  },
  // Editor file card: file type (text and class).
  "editor file card (file type)": async (page) => {
    await page.evaluate((m) => {
      const host = document.createElement("div");
      host.id = "file-host";
      host.innerHTML = renderFileCard(m);
      document.body.appendChild(host);
    }, evilMemory(6));
    return "#file-host";
  },
};

const launch = { headless: true };
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launch);
let failed = 0;
try {
  for (const [name, run] of Object.entries(checks)) {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("file:")) return route.continue();
      if (url.includes("supabase-js")) return route.fulfill({ contentType: "text/javascript", body: SUPABASE_STUB });
      return route.abort();
    });
    await page.goto(page_url);
    const selector = await run(page);
    await page.waitForTimeout(300);
    const result = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      return {
        imgs: root ? root.querySelectorAll("img").length : -1,
        pwned: window.__pwned || 0,
        literal: root ? root.textContent.includes("<img src=x") : false,
      };
    }, selector);
    const ok = result.imgs === 0 && result.pwned === 0 && result.literal;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: img elements ${result.imgs}, script ran ${result.pwned}, shown as text ${result.literal}`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
