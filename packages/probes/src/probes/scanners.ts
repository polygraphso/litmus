/**
 * Shared detection primitives for C-01 (injection) and C-03 (canaries),
 * implemented once and applied uniformly (litmus-test-v1 §3). Pure functions
 * over text — independently unit-testable; the place new failure modes are added.
 *
 * Each returns structured `Finding`s; probes decide pass/fail from severity.
 */

import type { Finding, Severity } from "@polygraph/core";

/** Half-window (UTF-16 code units) of bounded context captured around a finding's match. */
const CONTEXT_RADIUS = 48;
/** Hard cap on the matched span folded into the window, so a long regex match can't unbound it. */
const CONTEXT_MATCH_CAP = 120; // mirrors the `match` slice cap

/**
 * A deterministic, code-point-safe slice of `text` around [offset, offset+matchLen),
 * padded by CONTEXT_RADIUS each side and hard-capped, so a finding is self-classifying
 * from the bundle alone. Window edges are snapped off any split surrogate pair.
 */
function contextWindow(text: string, offset: number, matchLen: number): string {
  let start = Math.max(0, offset - CONTEXT_RADIUS);
  let end = Math.min(text.length, offset + Math.min(matchLen, CONTEXT_MATCH_CAP) + CONTEXT_RADIUS);
  if (start > 0 && (text.charCodeAt(start) & 0xfc00) === 0xdc00) start += 1; // drop dangling low surrogate
  if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end -= 1; // drop dangling high surrogate
  return text.slice(start, end);
}

/** Zero-width, bidi-override, and tag-char code points (litmus-test-v1 §C-01). */
function isInvisible(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200d) || // zero-width space/non-joiner/joiner
    cp === 0xfeff || // zero-width no-break space (BOM)
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding/override
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolates
    (cp >= 0xe0000 && cp <= 0xe007f) // Unicode tag characters
  );
}

export function invisibleUnicode(text: string): Finding[] {
  const findings: Finding[] = [];
  let offset = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisible(cp)) {
      findings.push({
        kind: "invisible-unicode",
        severity: "high",
        match: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
        offset,
        context: contextWindow(text, offset, ch.length),
      });
    }
    offset += ch.length;
  }
  return findings;
}

/**
 * Override/jailbreak framing, role tags, and free-text tool-call JSON are HIGH —
 * they are agent-hijack shaped and rare in honest tool docs. A bare imperative
 * ("you must/should/need to …") is only MEDIUM: legitimate tool descriptions say
 * "you must provide an absolute path" / "you need to specify the encoding" all the
 * time, so on its own it must NOT floor C-01 (which fails on HIGH). It stays in
 * the evidence as a weak signal; a real injection trips one of the high patterns.
 */
const MIMICRY: readonly { re: RegExp; severity: Severity }[] = [
  { re: /\bignore\s+(?:all\s+|the\s+|your\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?)\b/i, severity: "high" },
  { re: /\bdisregard\s+(?:all\s+|the\s+|your\s+)?(?:previous|prior|above)\b/i, severity: "high" },
  { re: /\b(?:new|updated|revised)\s+(?:instructions?|directives?|system\s+prompt)\b/i, severity: "high" },
  // A `system:` role label is injection-shaped only when it LEADS a line (at the
  // margin, optionally behind a single markdown-quote `>`). Anchoring to a line
  // start stops honest prose — "design system:", "operating system:" — and
  // allowing no indentation stops a `system:` KEY inside an indented config/YAML
  // example (`\n  system: gpt-4`) from flooring C-01/C-04 (litmus-v7, tightened v8).
  { re: /(?:^|[\r\n])>?[ \t]?system\s*:/i, severity: "high" },
  // `<system>`/`<assistant>` impersonate authority — flagged in every scan. The
  // weaker `<user>`/`<tool>` tags (common in honest tool docs) are flagged only in
  // runtime output — see WEAK_ROLE_TAG (litmus-v7).
  { re: /<\/?(?:system|assistant)\b[^>]*>/i, severity: "high" },
  // Only the OpenAI-style execute shapes `"tool_call"`/`"function_call"` are
  // injection-shaped. `"tool_name"`/`"function"` are honest field names (a tool
  // listing, a contract ABI), so flagging them floored honest JSON output (litmus-v8).
  { re: /"(?:tool_call|function_call)"\s*:/i, severity: "high" },
  { re: /\byou\s+(?:must|should|shall|will|need\s+to|have\s+to)\s+\w/i, severity: "medium" },
];

/**
 * Weaker role tags: `<user>`/`<tool>` appear constantly in honest tool documentation
 * ("wrap each call in <tool>…</tool>"), so they are NOT scanned in a tool's static
 * surface (probe 1.1). In runtime OUTPUT (probes 1.2/1.3) an injected role block is a
 * genuine hijack signal, so there they stay HIGH (litmus-v7).
 */
const WEAK_ROLE_TAG: { re: RegExp; severity: Severity } = {
  re: /<\/?(?:user|tool)\b[^>]*>/i,
  severity: "high",
};

/**
 * Scan text for injection-shaped instruction mimicry. With `staticSurface`, scans a
 * tool's advertised surface (name/description/schema text), where the weak
 * `<user>`/`<tool>` role tags are honest documentation and so are skipped; the
 * default scans runtime output, where those tags are flagged too.
 */
export function instructionMimicry(text: string, opts: { staticSurface?: boolean } = {}): Finding[] {
  const rules = opts.staticSurface ? MIMICRY : [...MIMICRY, WEAK_ROLE_TAG];
  const findings: Finding[] = [];
  for (const { re, severity } of rules) {
    const m = re.exec(text);
    if (m) {
      findings.push({
        kind: "instruction-mimicry",
        severity,
        match: m[0].slice(0, 120),
        offset: m.index,
        context: contextWindow(text, m.index, m[0].length),
      });
    }
  }
  return findings;
}

/**
 * Text extracted from a tool's JSON Schema for scanning — every string the schema
 * carries (property names, descriptions, titles, enum/default/example values), each
 * on its own line, but NOT the surrounding JSON punctuation. Scanning
 * `JSON.stringify(schema)` wholesale turned a parameter named `function` / `system`
 * into the substring `"function":` / `"system":`, tripping the tool-call-JSON and
 * role-label signatures on an honest schema. Emitting the bare tokens keeps a real
 * injection visible — whether it hides in a description OR in a property name — while
 * an honest key can no longer read as `"key":` tool-call JSON (litmus-v7).
 */
export function schemaText(schema: unknown): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else if (node !== null && typeof node === "object") {
      // Property NAMES are scanned as plain text (an injection phrase used as a key
      // is still caught) but never as `"key":`, so an honest parameter name like
      // `function` cannot read as tool-call JSON.
      for (const [key, value] of Object.entries(node)) {
        out.push(key);
        visit(value);
      }
    }
  };
  visit(schema);
  return out.join("\n");
}

/** Query-string key fragments that name a credential/secret — their presence in a
 *  query key a tool emits is exfil-shaped regardless of the value. Matched as plain
 *  per-key substrings (not one `[^=&]*TOKEN[^=&]*=` regex, which is polynomial on
 *  adversarial input — js/polynomial-redos). */
const SENSITIVE_QUERY_KEY_TOKENS = [
  "key", "token", "secret", "password", "passwd",
  "auth", "session", "cookie", "canary", "api", "env", "cred",
] as const;

/**
 * Whether a URL's query string looks like it carries exfiltrated data rather than
 * an honest search/tracking parameter. litmus-v5 narrows the old "any `?x=y`"
 * rule, which flagged honest links (`?q=search`, `?page=2`): now a query is
 * exfil-shaped only if a key names a credential, a value is long/high-entropy
 * (a smuggled secret), or it contains an interpolation marker (`${`, `{{`).
 */
function looksExfilQuery(url: string): boolean {
  const q = url.indexOf("?");
  if (q < 0) return false;
  const query = url.slice(q + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    if (SENSITIVE_QUERY_KEY_TOKENS.some((t) => key.includes(t))) return true;
    let v = pair.slice(eq + 1);
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    if (v.includes("${") || v.includes("{{")) return true; // template interpolation
    if (v.length >= 24) return true; // long enough to carry a secret
    if (/[A-Za-z0-9+/]{20,}={0,2}/.test(v) || /[0-9a-fA-F]{32,}/.test(v)) return true; // base64/hex blob
  }
  return false;
}

export function markdownTricks(text: string): Finding[] {
  const findings: Finding[] = [];

  // javascript:/data: URIs (high) — wherever they appear. The URI body excludes
  // markdown emphasis markers (`*`, `` ` ``) so a bold label that merely ends in
  // the word "data:"/"javascript:" — e.g. `**First-party data:**` — is not read
  // as a `data:**` URI. A real URI body never legitimately contains `**`.
  const proto = /\b(?:javascript|data):[^\s)"'<>*`]+/gi;
  for (let m = proto.exec(text); m; m = proto.exec(text)) {
    // A base64 RASTER image (`data:image/png;…`) is an honest inline image, not a
    // script-bearing URI — a tool that returns or documents one shouldn't floor
    // C-01/C-04 (litmus-v8). `data:text/html`, `data:application/*`, SVG (which can
    // carry script), and every `javascript:` URI still flag.
    if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)\b/i.test(m[0])) {
      continue;
    }
    findings.push({
      kind: "markdown-trick",
      severity: "high",
      match: m[0].slice(0, 120),
      offset: m.index,
      context: contextWindow(text, m.index, m[0].length),
    });
  }

  // Image/link whose URL carries an exfil-shaped query string (medium). Gated by
  // looksExfilQuery so an honest `?q=search` / `?page=2` link is not flagged. Every
  // run is bounded ({0,N}) and excludes its own terminator, so the unanchored scan
  // can't go quadratic on a long `[[[…` or `[](http://[](http://…` (js/polynomial-redos).
  const exfilImg = /!?\[[^\]]{0,200}\]\((https?:\/\/[^)\s?]{0,400}\?[^)\s=]{0,200}=[^)\s]{0,200})\)/gi;
  for (let m = exfilImg.exec(text); m; m = exfilImg.exec(text)) {
    const url = m[1] ?? m[0];
    if (!looksExfilQuery(url)) continue;
    findings.push({
      kind: "markdown-trick",
      severity: "medium",
      match: url.slice(0, 120),
      offset: m.index,
      context: contextWindow(text, m.index, m[0].length),
    });
  }

  return findings;
}

/**
 * Internals-leak / uncaught-error signatures (litmus-test-v1 §C-04). An honest
 * server answers a malformed input with a clean validation error; a fragile one
 * spills an uncaught stack trace, a runtime panic, or an interpreter traceback —
 * leaking absolute paths, framework internals, and sometimes secrets to the agent
 * that trusts it. The patterns are deliberately NARROW (unambiguous crash/trace
 * shapes), so a formatted "invalid input: field x is required" message does NOT
 * trip and a filesystem tool returning a bare path is not flagged — only raw
 * internals are. All HIGH: a leaked trace fails C-04.
 */
const INTERNALS_LEAK: readonly RegExp[] = [
  // V8 / Node stack frame: `at fn (/abs/file.js:12:5)` or `at /abs/file.js:12:5`
  // (a leading path/drive/`node:`/`file:` is required, so a "meet at 10:30:45"
  // timestamp can't trip it).
  // Bounded quantifiers ({0,300}) keep this linear: overlapping `.*\s` + `[^\s()]*`
  // + trailing `\s*$` over untrusted output is otherwise polynomial (js/polynomial-redos).
  /^\s*at\s+(?:[^\n]{0,300}\s)?\(?(?:\/|[A-Za-z]:[\\/]|node:|file:\/\/)[^\s()]{0,300}:\d+:\d+\)?\s*$/m,
  // Node uncaught-rejection / fatal banners.
  /\b(?:UnhandledPromiseRejection(?:Warning)?|unhandledRejection|FATAL ERROR:|Fatal error:)\b/,
  // Python traceback header + frame.
  /\bTraceback \(most recent call last\):/,
  /\bFile "[^"]+", line \d+, in /,
  // Java/JVM stack frame + thread banner.
  /\bat\s+[\w.$]+\([\w$]+\.java:\d+\)/,
  /\bException in thread "[^"]+"\s+[\w.$]+(?:Exception|Error)\b/,
  // Go panic with its goroutine dump (`panic: … goroutine 1 [running]:`).
  /\bpanic:[\s\S]{0,300}?\bgoroutine\s+\d+\s+\[/,
  // Ruby backtrace frame (`from app.rb:10:in 'method'` / older backtick form);
  // requires a `.rb` file + `:line:in` so prose can't trip it. The lookbehind +
  // bounded run keep `[\w./-]+\.rb` linear (the `.`-overlap is otherwise polynomial).
  /(?<![\w./-])[\w./-]{1,200}\.rb:\d+:in\s+['\x60]/,
  // .NET stack frame (`at NS.Method() in C:\path\File.cs:line 12`).
  /\bat\s+[\w.<>+]+\([^)]*\)\s+in\s+\S+:line\s+\d+/i,
  // Rust panic banner (`thread 'main' panicked at …`).
  /\bthread\s+'[^']+'\s+panicked\s+at\b/,
  // PHP uncaught-exception / fatal banner.
  /\bPHP\s+(?:Fatal|Parse)\s+error:/i,
  /\bFatal error:\s+Uncaught\b/i,
  // Native crash.
  /\b(?:segmentation fault|SIGSEGV|SIGABRT|core dumped)\b/i,
];

/** Scan output for uncaught stack traces / crash banners (C-04 probe 3.1). */
export function internalsLeak(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const re of INTERNALS_LEAK) {
    const m = re.exec(text);
    if (m) {
      findings.push({
        kind: "internals-leak",
        severity: "high",
        match: m[0].slice(0, 160).replace(/\s+/g, " ").trim(),
        offset: m.index,
      });
    }
  }
  return findings;
}

/**
 * Exact and lightly-obfuscated match of planted canaries (litmus-v1 §3:
 * "exact and lightly-obfuscated (case, whitespace, simple encodings)"). Beyond
 * exact + case-insensitive, it defeats whitespace-splitting and simple encodings
 * (base64/hex/url) by re-checking decoded/normalized views of the text. False
 * positives are bounded by requiring the *full, distinctive* canary to appear in
 * a view — random base64/hex won't decode to a `POLYGRAPH-CANARY-<uuid>`.
 */
export function canaryMatch(text: string, canaries: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const lower = text.toLowerCase();
  const views = obfuscatedViews(text);
  for (const c of canaries) {
    if (!c) continue;
    const exact = text.indexOf(c);
    if (exact >= 0) {
      findings.push({ kind: "canary", severity: "high", match: c, offset: exact });
      continue;
    }
    const ci = lower.indexOf(c.toLowerCase());
    if (ci >= 0) {
      findings.push({ kind: "canary", severity: "high", match: c, offset: ci });
      continue;
    }
    const lc = c.toLowerCase();
    const view = views.find((v) => v.text.includes(c) || v.text.toLowerCase().includes(lc));
    if (view) findings.push({ kind: "canary", severity: "high", match: `${c} (${view.label})` });
  }
  return findings;
}

/** Normalized/decoded views of the text that surface a whitespace-split or simply-encoded canary. */
function obfuscatedViews(text: string): Array<{ label: string; text: string }> {
  const views: Array<{ label: string; text: string }> = [
    { label: "whitespace-stripped", text: text.replace(/\s+/g, "") },
  ];
  try {
    views.push({ label: "url-decoded", text: decodeURIComponent(text) });
  } catch {
    /* malformed % sequence — skip */
  }
  for (const m of text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)) {
    const d = decodeBuf(m[0], "base64");
    if (d) views.push({ label: "base64-decoded", text: d });
  }
  for (const m of text.matchAll(/[0-9a-fA-F]{32,}/g)) {
    if (m[0].length % 2 === 0) {
      const d = decodeBuf(m[0], "hex");
      if (d) views.push({ label: "hex-decoded", text: d });
    }
  }
  return views;
}

function decodeBuf(s: string, enc: "base64" | "hex"): string | null {
  try {
    const d = Buffer.from(s, enc).toString("utf8");
    return /[\x20-\x7e]/.test(d) ? d : null; // must yield some printable ASCII to be worth scanning
  } catch {
    return null;
  }
}

/** True if any finding is high-severity (the C-01 fail bar). */
export function hasHighSeverity(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === "high");
}
