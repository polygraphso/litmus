/**
 * Optional LLM-judged quality axes — the "is it honest / coherent" signal that
 * static scanning provably cannot decide (this is the semantic S-02 we kept OUT of
 * the deterministic letter). It is ADVISORY, NON-DETERMINISTIC, and provider-
 * AGNOSTIC: it runs against any `Judge`, never floors the safety letter, and is
 * never minted.
 *
 * Provider-agnostic by design:
 *  - inside an agent, the host model judges via MCP sampling (no key — the adapter
 *    lives in the litmus package, where the server connection is);
 *  - standalone, the user brings their OWN key for any OpenAI-compatible endpoint
 *    (OpenAI, OpenRouter, Groq, Google's compat layer, a local model, …);
 *  - with neither, the judged axes are simply skipped — the litmus core needs no key.
 *
 * Repeatability is majority-over-k + a recorded judge id, not seeding (modern models
 * don't expose a usable temperature). The agreement ratio is reported honestly.
 */
import type { LoadedSkill } from "./load-skill.js";
import type { JudgedQuality } from "./quality.js";

/** Provider-agnostic completion. Implementations: MCP sampling, OpenAI-compatible. */
export interface Judge {
  /** Stable label recorded in the bundle (e.g. "mcp-sampling", "openai-compat:gpt-4o"). */
  readonly id: string;
  complete(system: string, user: string): Promise<string>;
}

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * A Judge over any OpenAI-compatible Chat Completions endpoint. Uses global fetch
 * (Node ≥18) — no SDK dependency. Sends only model/messages/max_tokens for the
 * widest provider compatibility (temperature is omitted; many models reject it and
 * repeatability comes from majority-over-k anyway).
 */
export function openAICompatJudge(cfg: OpenAICompatConfig): Judge {
  // Trim trailing slashes without a regex — `/\/+$/` is unanchored and quadratic
  // on a long `////…` base URL (js/polynomial-redos).
  let base = cfg.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const url = `${base}/chat/completions`;
  return {
    id: `openai-compat:${cfg.model}`,
    async complete(system, user) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1024,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`judge request failed: HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data?.choices?.[0]?.message?.content ?? "";
    },
  };
}

/** Build an OpenAI-compatible judge from env, or null if no key is configured.
 *  LITMUS_LLM_API_KEY (+ LITMUS_LLM_MODEL; LITMUS_LLM_BASE_URL defaults to OpenAI). */
export function judgeFromEnv(env: NodeJS.ProcessEnv = process.env): Judge | null {
  const apiKey = env.LITMUS_LLM_API_KEY;
  const model = env.LITMUS_LLM_MODEL;
  if (!apiKey || !model) return null;
  return openAICompatJudge({ apiKey, model, baseUrl: env.LITMUS_LLM_BASE_URL ?? "https://api.openai.com/v1" });
}

const AXES = ["honesty", "coherence"] as const;
type Axis = (typeof AXES)[number];
type Rating = "good" | "concern" | "bad";
const RATINGS: readonly Rating[] = ["good", "concern", "bad"];

const SYSTEM =
  "You are a strict, terse reviewer of Claude Code \"skills\" (instruction files an AI agent loads). " +
  "Judge ONLY two axes. honesty: does the body do anything material its frontmatter `description` does " +
  "not disclose, or claim a far broader/narrower scope than it delivers? coherence: are the instructions " +
  "clear, internally consistent, and actually followable? Rate each good|concern|bad. " +
  'Reply with ONLY a JSON object: {"honesty":{"rating":"...","why":"<=20 words"},"coherence":{"rating":"...","why":"<=20 words"}}. No prose.';

function buildUserPrompt(loaded: LoadedSkill): string {
  const body = loaded.body.length > 12000 ? loaded.body.slice(0, 12000) + "\n…[truncated]" : loaded.body;
  return `description: ${loaded.description || "(none)"}\n\n--- SKILL BODY ---\n${body}`;
}

/** Extract the first JSON object from possibly-fenced model output. */
function parseVerdict(text: string): Record<Axis, Rating> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const out = {} as Record<Axis, Rating>;
  for (const axis of AXES) {
    const r = (obj as Record<string, { rating?: unknown }>)?.[axis]?.rating;
    if (typeof r !== "string" || !RATINGS.includes(r as Rating)) return null;
    out[axis] = r as Rating;
  }
  return out;
}

function majority(ratings: Rating[]): { rating: Rating; count: number } {
  const tally = new Map<Rating, number>();
  for (const r of ratings) tally.set(r, (tally.get(r) ?? 0) + 1);
  // Tie-break toward the more cautious rating (bad > concern > good).
  let best: Rating = "good";
  let bestN = -1;
  for (const r of RATINGS) {
    const n = tally.get(r) ?? 0;
    if (n > bestN || (n === bestN && RATINGS.indexOf(r) > RATINGS.indexOf(best))) {
      best = r;
      bestN = n;
    }
  }
  return { rating: best, count: bestN };
}

export interface JudgeOptions {
  /** Samples per run; majority-voted. Default 1 (host-agent sampling is not free). */
  samples?: number;
}

/**
 * Run the judged axes against a skill. Draws `samples` verdicts, majority-votes per
 * axis, and reports the agreement ratio. Throws only if EVERY sample failed (no
 * usable verdict) — callers treat that, and "no judge", as "judged axes not run".
 */
export async function judgeSkillQuality(loaded: LoadedSkill, judge: Judge, opts: JudgeOptions = {}): Promise<JudgedQuality> {
  const samples = Math.max(1, Math.min(opts.samples ?? 1, 5));
  const user = buildUserPrompt(loaded);
  const verdicts: Record<Axis, Rating>[] = [];
  for (let i = 0; i < samples; i++) {
    const v = parseVerdict(await judge.complete(SYSTEM, user));
    if (v) verdicts.push(v);
  }
  if (verdicts.length === 0) throw new Error("judge returned no parseable verdict");

  let minAgreement = 1;
  const axes = AXES.map((axis) => {
    const m = majority(verdicts.map((v) => v[axis]));
    minAgreement = Math.min(minAgreement, m.count / verdicts.length);
    return { axis, rating: m.rating, rationale: `majority of ${verdicts.length} sample(s)` };
  });

  return {
    judge: judge.id,
    samples: verdicts.length,
    agreement: Number(minAgreement.toFixed(2)),
    axes,
    note:
      "Advisory, non-deterministic: produced by an LLM judge, not the reproducible static scan. " +
      "Repeatability is majority-over-k, not bit-identical. Never affects the safety letter and is never minted.",
  };
}
