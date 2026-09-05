/**
 * e2e.mjs — exercise the installed pi-text-to-image plugin code directly
 * (no LLM, endpoint stubbed). Verifies:
 *   T1: destinations outside the workspace are rejected (no HTTP call made)
 *   T2: two concurrent requests are serialized by the FIFO queue
 *   T3: default destination lands in <ws>/images/<slug>-<timestamp>.png
 */
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_DIR =
  "/Users/user/.nvm/versions/node/v22.20.0/lib/node_modules/@earendil-works/pi-coding-agent";
const PLUGIN = "/Users/user/repos/pi-text-to-image/index.ts";

const require = createRequire(join(PI_DIR, "noop.js")); // resolves pi's node_modules
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    typebox: require.resolve("typebox"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    // "@earendil-works/pi-coding-agent" is a type-only import — jiti erases it
  },
});

const { default: makeExt } = await jiti.import(PLUGIN);

let registered = null;
makeExt({ registerTool: (def) => (registered = def) });
if (!registered || registered.name !== "text_to_image") throw new Error("tool not registered");

const ws = await mkdtemp(join(tmpdir(), "t2i-ws-"));
const pngBytes = Buffer.from("fake-png-bytes");
const calls = []; // { start, end } timestamps of endpoint hits
let callCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  const start = Date.now();
  calls.push({ start, end: null });
  const idx = callCount++;
  await new Promise((r) => setTimeout(r, 300)); // simulate generation time
  calls[idx].end = Date.now();
  return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const ctx = { cwd: ws };
const fail = (msg) => {
  globalThis.fetch = realFetch;
  console.error(`❌ ${msg}`);
  process.exit(1);
};

// ── T1: workspace escape rejected, no HTTP call ──────────────────────────
const r1 = await registered.execute(
  "t1",
  { prompt: "test", path: "/tmp/evil.png" },
  undefined,
  undefined,
  ctx,
);
console.log("T1:", r1.content[0].text);
if (!r1.content[0].text.includes("outside the workspace")) fail("T1: escape not rejected");
if (callCount !== 0) fail("T1: endpoint was called despite rejection");
console.log("✅ T1 passed: outside-workspace path rejected, no HTTP call\n");

// ── T2: concurrent requests serialized, positions reported ───────────────
const [r2, r3] = await Promise.all([
  registered.execute("t2", { prompt: "one", path: "a.png", size: "512x512" }, undefined, undefined, ctx),
  registered.execute("t3", { prompt: "two", path: "b.png", size: "512x512" }, undefined, undefined, ctx),
]);
console.log("T2 r2:", r2.content[0].text);
console.log("T2 r3:", r3.content[0].text);
if (r3.details.queuePosition !== 1) fail(`T2: expected queuePosition 1, got ${r3.details.queuePosition}`);
if (calls.length !== 2) fail(`T2: expected 2 endpoint calls, got ${calls.length}`);
if (calls[1].start < calls[0].end) {
  fail(`T2: requests overlapped (${calls[0].end} vs ${calls[1].start})`);
}
for (const f of [join(ws, "a.png"), join(ws, "b.png")]) {
  const b = await readFile(f).catch(() => null);
  if (!b || !b.equals(pngBytes)) fail(`T2: ${f} missing or wrong content`);
}
console.log("✅ T2 passed: requests serialized, queue position reported, files written\n");

// ── T3: default destination ──────────────────────────────────────────────
const r4 = await registered.execute("t4", { prompt: "A Red Fox!" }, undefined, undefined, ctx);
console.log("T3:", r4.content[0].text);
const m = r4.content[0].text.match(/to (\S+\.png)/);
if (!m) fail("T3: could not parse destination from result");
if (!m[1].startsWith(join(ws, "images/"))) fail(`T3: not under images/: ${m[1]}`);
if (!/red-fox-/.test(m[1])) fail(`T3: slug missing: ${m[1]}`);
if (!(await existsSync(m[1]))) fail(`T3: file not written: ${m[1]}`);
console.log("✅ T3 passed: default path is <ws>/images/<slug>-<timestamp>.png\n");

// ── T4: renderCall shows the requested image text; renderResult shows status ─
const theme = { fg: (c, s) => `⟦${c}⟧${s}`, bold: (s) => s };
const callLines = registered
  .renderCall({ prompt: "a red fox", path: "images/fox.png", size: "512x512" }, theme, { lastComponent: undefined })
  .render(80)
  .join(" ");
console.log("T4 call:", callLines);
for (const needle of ['"a red fox"', "images/fox.png", "512x512"]) {
  if (!callLines.includes(needle)) fail(`T4: renderCall missing ${needle}`);
}

const okRes = registered.renderResult(
  { content: [{ type: "text", text: "Saved" }], details: { path: "\u002Fws/images/fox.png", width: 512, height: 512, elapsedSeconds: 42.3, queuePosition: 1 } },
  { expanded: false, isPartial: false },
  theme,
  {},
);
const okLines = okRes.render(80).join(" ");
console.log("T4 ok:  ", okLines);
for (const needle of ["/ws/images/fox.png", "512x512", "waited behind 1"]) {
  if (!okLines.includes(needle)) fail(`T4: renderResult missing ${needle}`);
}

const partialLines = registered
  .renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, {})
  .render(80)
  .join(" ");
if (!partialLines.includes("Generating")) fail(`T4: isPartial branch missing: ${partialLines}`);

const errLines = registered
  .renderResult({ content: [{ type: "text", text: "x" }], details: { error: "text_to_image: endpoint returned HTTP 500" } }, { expanded: false, isPartial: false }, theme, {})
  .render(80)
  .join(" ");
if (!errLines.includes("HTTP 500")) fail(`T4: error branch missing: ${errLines}`);
console.log("✅ T4 passed: renderCall shows prompt text; renderResult shows status/error\n");

globalThis.fetch = realFetch;
await rm(ws, { recursive: true, force: true });
console.log("✅ ALL TESTS PASSED (real plugin code, stubbed endpoint)");
