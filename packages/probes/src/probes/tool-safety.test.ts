import { describe, it, expect } from "vitest";
import { classifyTool, declarationMismatch, stateChangingToolNames, skippedNote } from "./tool-safety.js";

describe("classifyTool — annotations are authoritative", () => {
  it("readOnlyHint:true is safe even with a scary name", () => {
    expect(classifyTool({ name: "send_report", annotations: { readOnlyHint: true } })).toEqual({
      stateChanging: false,
    });
  });

  it("destructiveHint:true is state-changing even with a benign name", () => {
    const c = classifyTool({ name: "tidy", annotations: { destructiveHint: true } });
    expect(c.stateChanging).toBe(true);
    expect(c.reason).toMatch(/destructiveHint/);
  });

  it("readOnlyHint:false is state-changing", () => {
    const c = classifyTool({ name: "fetch_data", annotations: { readOnlyHint: false } });
    expect(c.stateChanging).toBe(true);
    expect(c.reason).toMatch(/readOnlyHint:false/);
  });
});

describe("classifyTool — verb heuristic (no annotations)", () => {
  it.each([
    ["send", "send"],
    ["swap_tokens", "swap"], // snake_case — \b would miss this; tokenization catches it
    ["sign", "sign"],
    ["transfer_funds", "transfer"],
    ["send_calls", "send"],
    ["deleteEntities", "delete"], // camelCase
    ["create_wallet", "create"],
  ])("flags %s as state-changing", (name, verb) => {
    const c = classifyTool({ name });
    expect(c.stateChanging).toBe(true);
    expect(c.reason).toContain(verb);
  });

  it("matches the tool name only, not the (noisy) description", () => {
    // A read-only tool whose docs mention an action verb must stay exercisable,
    // or clean servers lose coverage (and demo canary tools could be skipped).
    const c = classifyTool({ name: "get_balance", description: "Read it before you send funds" });
    expect(c.stateChanging).toBe(false);
  });

  it("leaves read-only tools exercisable", () => {
    for (const name of ["read_graph", "search_nodes", "get_balance", "list_files", "echo"]) {
      expect(classifyTool({ name }).stateChanging).toBe(false);
    }
  });

  it("does not match a verb embedded in a larger word (word-boundary)", () => {
    // "resend" / "approver" should not match "send"/"approve" as whole words…
    expect(classifyTool({ name: "addressbook" }).stateChanging).toBe(false);
    // …but a real verb token within snake_case does.
    expect(classifyTool({ name: "address_send" }).stateChanging).toBe(true);
  });
});

describe("declarationMismatch — a read-only claim that contradicts an unambiguously destructive name", () => {
  it.each([
    ["delete_account", "delete"],
    ["drop_table", "drop"],
    ["transfer_funds", "transfer"],
    ["send_email", "send"],
    ["withdraw", "withdraw"],
    ["signTransaction", "sign"], // camelCase
  ])("flags %s annotated readOnlyHint:true as a mislabel (verb %s)", (name, verb) => {
    expect(declarationMismatch({ name, annotations: { readOnlyHint: true } })).toBe(verb);
  });

  it("does NOT flag polysemous verbs — a read-only claim on create/update/execute is honest", () => {
    for (const name of ["create_query", "update_cache", "execute_search", "list_orders", "move_cursor"]) {
      expect(declarationMismatch({ name, annotations: { readOnlyHint: true } })).toBeNull();
    }
  });

  it("does NOT flag a destructive name when there is no read-only claim to contradict", () => {
    // Honest: the verb heuristic (classifyTool) already skips it from exercise.
    expect(declarationMismatch({ name: "delete_account" })).toBeNull();
    expect(declarationMismatch({ name: "delete_account", annotations: { readOnlyHint: false } })).toBeNull();
    expect(declarationMismatch({ name: "delete_account", annotations: { destructiveHint: true } })).toBeNull();
  });

  it("does NOT flag an honest read-only tool", () => {
    for (const name of ["get_balance", "read_graph", "search_nodes", "list_files"]) {
      expect(declarationMismatch({ name, annotations: { readOnlyHint: true } })).toBeNull();
    }
  });
});

describe("stateChangingToolNames + skippedNote", () => {
  it("collects only the state-changing tool names", () => {
    const names = stateChangingToolNames([
      { name: "read_graph" },
      { name: "send", annotations: { readOnlyHint: false } },
      { name: "swap" },
      { name: "get_env" },
    ]);
    expect([...names].sort()).toEqual(["send", "swap"]);
  });

  it("formats a human-readable skip note that names the opt-out flag", () => {
    expect(skippedNote(["send", "swap"])).toBe(
      "2 tool(s) skipped (state-changing; pass --allow-state-changing): send, swap",
    );
  });
});
