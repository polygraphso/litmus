/**
 * `polygraphso check <ref>` — a sub-second lookup over precomputed grades.
 * Zero-dependency fast path (no harness import). Wired to the discovery API in M3.
 */

export async function runCheck(args: readonly string[]): Promise<number> {
  const ref = args[0];
  if (!ref) {
    process.stderr.write("usage: polygraphso check <registry-ref>\n");
    return 2;
  }
  process.stdout.write(
    [
      `→ ${ref}`,
      "→ polygraph: not yet available",
      `→ run a behavioral litmus: polygraphso litmus ${ref}`,
      "",
    ].join("\n"),
  );
  return 0;
}
