/**
 * Shared detection primitives for C-01 (injection) and C-03 (canaries),
 * implemented once and applied uniformly (litmus-test-v1 §3). Pure functions
 * over text — independently unit-testable; the place new failure modes are added.
 *
 * Each returns structured `Finding`s; probes decide pass/fail from severity.
 */

import type { Finding, Severity } from "@polygraph/core";

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
  { re: /(?:^|[\s>])system\s*:/i, severity: "high" },
  { re: /<\/?(?:system|assistant|user|tool)\b[^>]*>/i, severity: "high" },
  { re: /"(?:tool_call|function_call|tool_name|function)"\s*:/i, severity: "high" },
  { re: /\byou\s+(?:must|should|shall|will|need\s+to|have\s+to)\s+\w/i, severity: "medium" },
];

export function instructionMimicry(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { re, severity } of MIMICRY) {
    const m = re.exec(text);
    if (m) {
      findings.push({
        kind: "instruction-mimicry",
        severity,
        match: m[0].slice(0, 120),
        offset: m.index,
      });
    }
  }
  return findings;
}

export function markdownTricks(text: string): Finding[] {
  const findings: Finding[] = [];

  // javascript:/data: URIs (high) — wherever they appear.
  const proto = /\b(?:javascript|data):[^\s)"'<>]+/gi;
  for (let m = proto.exec(text); m; m = proto.exec(text)) {
    findings.push({
      kind: "markdown-trick",
      severity: "high",
      match: m[0].slice(0, 120),
      offset: m.index,
    });
  }

  // Image/link whose URL carries an exfil-shaped query string (medium).
  const exfilImg = /!?\[[^\]]*\]\((https?:\/\/[^)\s]*\?[^)\s]*=[^)\s]*)\)/gi;
  for (let m = exfilImg.exec(text); m; m = exfilImg.exec(text)) {
    findings.push({
      kind: "markdown-trick",
      severity: "medium",
      match: (m[1] ?? m[0]).slice(0, 120),
      offset: m.index,
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
  /^\s*at\s+(?:.*\s)?\(?(?:\/|[A-Za-z]:[\\/]|node:|file:\/\/)[^\s()]*:\d+:\d+\)?\s*$/m,
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
