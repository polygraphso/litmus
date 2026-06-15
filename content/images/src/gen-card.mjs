#!/usr/bin/env node
/**
 * gen-card.mjs — render a shareable "terminal" grade card (PNG) from a real
 * litmus-v1 run. These cards are HTML/CSS mockups (see card.css) rendered by
 * headless Chromium — the look is templated, but the data is genuine harness
 * output, so every card is traceable to a reproducible grade.
 *
 * Modes:
 *   node gen-card.mjs <target> [opts]      grade <target> and render its card
 *   node gen-card.mjs --html <file> [opts] render an existing HTML (leaderboard,
 *                                          reproducibility) — no grading
 *
 * Options:
 *   --from-json <file>   use an existing `litmus --json` bundle (skip the run)
 *   --out <path>         output PNG (default: content/images/grade-<g>-<slug>.png)
 *   --caption "<text>"   editorial line under the card (default: grade-aware)
 *   --size <WxH>         render size (default 1500x820)
 *   --bearer <token>     passed through to litmus (OAuth remote targets)
 *   --header "K: V"      passed through to litmus (repeatable)
 *
 * Chromium: auto-detected from the Playwright cache or a system install.
 * Override with CHROME_BIN=/path/to/chrome.
 *
 * Examples:
 *   pnpm card npm/@modelcontextprotocol/server-filesystem
 *   pnpm card https://mcp.deepwiki.com/mcp --out content/images/deepwiki.png
 *   pnpm card --html content/images/src/leaderboard.html \
 *     --out content/images/06-popular-mcp-servers-leaderboard.png --size 1620x820
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const IMAGES_DIR = resolve(__dirname, "..");
const CSS = readFileSync(join(__dirname, "card.css"), "utf8");

// ---- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { size: "1500x820", headers: [] };
let target = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--html") opts.html = argv[++i];
  else if (a === "--from-json") opts.fromJson = argv[++i];
  else if (a === "--out") opts.out = argv[++i];
  else if (a === "--caption") opts.caption = argv[++i];
  else if (a === "--size") opts.size = argv[++i];
  else if (a === "--bearer") opts.bearer = argv[++i];
  else if (a === "--header") opts.headers.push(argv[++i]);
  else if (a.startsWith("--")) die(`unknown option: ${a}`);
  else target = a;
}
const [W, H] = opts.size.split("x").map(Number);
if (!W || !H) die(`bad --size "${opts.size}" (expected WxH, e.g. 1500x820)`);

function die(msg) {
  console.error(`gen-card: ${msg}`);
  process.exit(1);
}

// ---- chromium resolver -----------------------------------------------------
function resolveChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const home = process.env.HOME || "";
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, "Library/Caches/ms-playwright"), // macOS
    join(home, ".cache/ms-playwright"), // Linux
  ].filter(Boolean);
  const wanted = ["chrome-headless-shell", "headless_shell", "Google Chrome for Testing", "Chromium", "chrome"];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    // headless shells first (smallest, fastest), then full chromium
    const dirs = readdirSync(cache).sort((a, b) =>
      (b.startsWith("chromium_headless_shell") ? 1 : 0) - (a.startsWith("chromium_headless_shell") ? 1 : 0));
    for (const d of dirs) {
      const hit = findExec(join(cache, d), wanted, 4);
      if (hit) return hit;
    }
  }
  // system installs
  const sys = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of sys) if (existsSync(p)) return p;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execFileSync("which", [bin], { encoding: "utf8" }).trim(); } catch {}
  }
  die("no Chromium found. Set CHROME_BIN=/path/to/chrome, or install the Playwright browsers (npx playwright install chromium).");
}

function findExec(dir, names, depth) {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && names.includes(e.name)) {
      try { if (statSync(p).mode & 0o111) return p; } catch {}
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findExec(join(dir, e.name), names, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

// ---- render ----------------------------------------------------------------
function render(htmlPath, outPath) {
  const chrome = resolveChrome();
  mkdirSync(dirname(outPath), { recursive: true });
  execFileSync(chrome, [
    "--headless", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=2", "--default-background-color=00000000",
    `--screenshot=${outPath}`, `--window-size=${W},${H}`,
    `file://${htmlPath}`,
  ], { stdio: "ignore" });
  if (!existsSync(outPath)) die(`render produced no file at ${outPath}`);
  return outPath;
}

// ---- data → card -----------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const truncFp = (fp) => { const h = String(fp).replace(/^0x/, ""); return `0x${h.slice(0, 4)}…${h.slice(-4)}`; };

function catToken(code, status) {
  const color = status === "pass" ? "var(--green)"
    : status === "fail" ? (code === "C-02" ? "var(--amber)" : "var(--red)")
    : status === "partial" ? "var(--amber)" : "var(--dim)";
  const label = status === "skipped" ? "skipped" : status;
  const token = `${code} <span style="color:${color}">${label}</span>`;
  return (status === "fail" || status === "skipped")
    ? `<span class="hl-line">${token}</span>` : token;
}

const DEFAULT_CAPTION = {
  A: "all three behavioral probes pass. the harness is open and deterministic — re-run it and you get the same grade.",
  B: "remote target — egress isn't observable without the sandbox, so it caps at B. injection + data checks pass.",
  D: "undeclared egress caught in the sandbox. no injection or data leak — a probe-cited, reproducible result.",
  F: "a disqualifying C-01/C-03 failure. a dated, reproducible litmus-v1 measurement, not an accusation.",
};

function buildCardHtml(bundle, displayTarget) {
  const cats = bundle.categories || [];
  const get = (code) => cats.find((c) => c.code === code)?.status ?? "skipped";
  const line = ["C-01", "C-02", "C-03"].map((c) => catToken(c, get(c))).join(" · ");
  const grade = bundle.grade;
  const caption = opts.caption ?? DEFAULT_CAPTION[grade] ?? "a reproducible litmus-v1 grade.";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
  <div class="terminal">
    <div class="bar"><div class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div><div class="title">litmus — grade</div></div>
    <div class="pane">
      <div class="cmd"><span class="ps1">$ </span>litmus ${esc(displayTarget)}</div>
      <div class="out">
        <span class="line"><span class="arrow">→</span> litmus-v1 · ${esc(bundle.serverRef)}</span>
        <span class="line"><span class="arrow">→</span> ${line}</span>
        <span class="line"><span class="arrow">→</span> fingerprint <span class="fp">${truncFp(bundle.toolDefsFingerprint)}</span></span>
        <span class="line"><span class="arrow">→</span> grade: <span class="grade ${grade}">${grade}</span></span>
        <span class="rationale">${esc(bundle.gradeRationale || "")}</span>
      </div>
    </div>
  </div>
  <div class="caption">${caption}</div>
  <div class="brand">polygraph · <b>litmus-v1</b></div>
</body></html>`;
}

function slug(serverRef) {
  return String(serverRef).replace(/^npm\//, "").replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

// ---- main ------------------------------------------------------------------
if (opts.html) {
  const out = opts.out || join(IMAGES_DIR, `${slug(opts.html.replace(/\.html$/, ""))}.png`);
  console.log(`rendering ${opts.html} → ${out} (${W}×${H})`);
  render(resolve(opts.html), resolve(out));
  console.log("done.");
} else {
  if (!target && !opts.fromJson) die("need a <target> (e.g. npm/@scope/name) or --from-json <file>. See --help in the header.");
  let bundle;
  if (opts.fromJson) {
    bundle = JSON.parse(readFileSync(opts.fromJson, "utf8"));
  } else {
    const cliArgs = ["tsx", "packages/cli/src/cli.ts", "litmus", target, "--json"];
    if (opts.bearer) cliArgs.push("--bearer", opts.bearer);
    for (const h of opts.headers) cliArgs.push("--header", h);
    console.error(`running: npx ${cliArgs.join(" ")}`);
    const stdout = execFileSync("npx", cliArgs, {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"],
    });
    bundle = JSON.parse(stdout);
  }
  // bundle.target is a structured object, not a string — use the human ref.
  const displayTarget = target || bundle.serverRef;
  const out = opts.out || join(IMAGES_DIR, `grade-${String(bundle.grade).toLowerCase()}-${slug(bundle.serverRef)}.png`);
  const tmp = join(tmpdir(), `pg-card-${process.pid}.html`);
  writeFileSync(tmp, buildCardHtml(bundle, displayTarget));
  console.log(`grade ${bundle.grade} · ${bundle.serverRef} → ${out} (${W}×${H})`);
  render(tmp, resolve(out));
  console.log("done.");
}
