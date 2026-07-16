/**
 * `request_grade` — record a grade request with polygraph.so. The natural
 * follow-up when `check_server` returns not_available and running the litmus
 * locally isn't an option.
 *
 * Grading is fee-gated: recording the request is free (it counts demand), but
 * polygraph runs the litmus once the request's small one-time fee is paid —
 * then the grade publishes within 48 hours. The response carries the payment
 * link; surface it to the user. The fee buys the run, never the grade.
 *
 * No contact details: the caller is an agent, so the request carries the
 * connected client's self-reported identity (from the MCP handshake) instead
 * of an email. Read the result later by calling `check_server` again.
 */

import { z } from "zod";
import { postGradeRequest } from "../api.js";
import { lookupErrorResult } from "./check-server.js";
import type { ClientAgent } from "../client-id.js";

export const REQUEST_GRADE_TOOL_NAME = "request_grade";
export const REQUEST_GRADE_TOOL_TITLE = "Request a polygraph grade for an MCP server";
export const REQUEST_GRADE_TOOL_DESCRIPTION = [
  "Record a grade request with polygraph.so.",
  "",
  "Use this when `check_server` returns not_available and you want the server",
  "graded without running anything yourself. Recording the request is free;",
  "grading starts once the request's one-time fee (about $1) is paid, and the",
  "grade publishes within 48 hours of payment. The result includes the payment",
  "link — show it to the user. The fee buys the run, never the grade. This does",
  "not return a grade synchronously; read it later by calling `check_server`",
  "again. To grade the server right now instead, use `run_litmus`.",
  "",
  "Payment options: the web checkout at the returned `payUrl` (paid in",
  "$POLYGRAPH), or — for x402-capable clients — POST the same request to the",
  "returned `x402Url` with an X-PAYMENT header ($1 USDC on Base).",
  "",
  "No contact details are needed. Requesting the same server twice is a no-op,",
  "not a duplicate.",
  "",
  "Input: `server_ref` — the same registry-prefixed identifier `check_server`",
  "takes (npm/@scope/name, pypi/name, github/owner/repo).",
  "",
  "Returns `{ status: 'queued', created, demand, requestId, payment }` —",
  "`created` is false if it was already recorded, `demand` is how many requests",
  "stand behind it, `payment.required` says whether the fee is still owed.",
].join("\n");

export const requestGradeInputShape = {
  server_ref: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Registry-prefixed server identifier, e.g. 'npm/@modelcontextprotocol/server-filesystem', 'pypi/mcp-server-git', or 'github/owner/repo'.",
    ),
};

/**
 * @param agent identity of the connected MCP client (name/version + declared
 *   meta from the initialize handshake), recorded so the queue knows who
 *   asked. Undefined fields when the client didn't announce itself.
 */
export async function handleRequestGrade(
  { server_ref }: { server_ref: string },
  agent?: ClientAgent,
) {
  try {
    const body = await postGradeRequest(server_ref, agent);
    const recorded = body.created
      ? `Recorded ${server_ref} for grading (${body.demand} request(s) behind it).`
      : `${server_ref} was already recorded (${body.demand} request(s) behind it).`;
    let text: string;
    if (body.payment && !body.payment.required) {
      text = `${recorded} Its grading fee is already paid — the grade publishes within 48h of that payment. Call check_server again later to read the result.`;
    } else if (body.payment?.payUrl) {
      text = [
        recorded,
        `Grading starts once its one-time $${body.payment.usdPrice} fee is paid — then the grade publishes within 48 hours.`,
        `Pay at ${body.payment.payUrl}`,
        `(x402-capable clients can instead POST the same request with an X-PAYMENT header — $${body.payment.usdPrice} USDC on Base — to ${body.payment.x402Url}.)`,
        `Call check_server again later to read the result.`,
      ].join(" ");
    } else {
      // Older deployment without payment info in the response.
      text = `${recorded} It'll be graded best-effort — call check_server again later to read the result.`;
    }
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: body as unknown as { [key: string]: unknown },
    };
  } catch (err) {
    return lookupErrorResult(err);
  }
}
