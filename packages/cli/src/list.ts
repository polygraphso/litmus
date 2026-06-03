/**
 * `polygraphso list` — list servers with published grades. Discovery lands in
 * M3 (reads `/api/attestations`); a stub until then.
 */

export async function runList(_args: readonly string[]): Promise<number> {
  process.stdout.write("→ no published grades yet (discovery lands in M3)\n");
  return 0;
}
