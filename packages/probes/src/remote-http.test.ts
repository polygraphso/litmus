/**
 * runLitmus against a REAL remote (Streamable HTTP) MCP target (litmus-v17).
 *
 * A loopback http server stands in for a remote operator: `runLitmus` still
 * takes the `isHttp` branch (an `http://` URL string), which is what actually
 * exercises the remote-grading code paths this file is testing. The SSRF
 * guard normally refuses a private/loopback address; `POLYGRAPH_ALLOW_PRIVATE_TARGETS`
 * is its documented escape hatch for exactly this kind of local test.
 *
 * The server is session-aware (one fresh McpServer per initialized session,
 * tracked by session id): `runLitmus` opens one connection to grade, then
 * litmus-v17's same-session recheck opens ONE MORE independent connection
 * afterward, so the target needs to support two live sessions at once.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { runLitmus } from "./harness.js";

const ECHO_DESCRIPTION = "Return the provided message unchanged.";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

async function listen(httpServer: HttpServer): Promise<RunningServer> {
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/**
 * A session-aware Streamable HTTP MCP server: each NEW session (an
 * `initialize` request with no known `Mcp-Session-Id`) gets its own fresh
 * `McpServer`, built by `registerTools`, keyed by the session's 1-based
 * ordinal so a target can serve a different surface to its Nth session.
 * Requests carrying a known session id are routed to that session's own
 * transport, so two independent connections can be live at once.
 */
function startSessionAwareServer(registerTools: (mcp: McpServer, sessionOrdinal: number) => void): Promise<RunningServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let sessionsStarted = 0;

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        const sessionHeader = req.headers["mcp-session-id"];
        const existing = typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
        if (existing) {
          await existing.handleRequest(req, res);
          return;
        }
        sessionsStarted++;
        const mcp = new McpServer({ name: "demo-remote", version: "1.0.0" });
        registerTools(mcp, sessionsStarted);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, transport);
          },
        });
        transport.onclose = () => {
          for (const [sid, t] of sessions) if (t === transport) sessions.delete(sid);
        };
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      }
    })();
  });
  return listen(httpServer);
}

function registerEcho(mcp: McpServer): void {
  mcp.registerTool(
    "echo",
    { title: "Echo", description: ECHO_DESCRIPTION, inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: "text" as const, text: String(message) }] }),
  );
}

/** A single stable "echo" tool for every session: nothing to fail, nothing
 *  to leak, and the surface never changes between sessions. */
function startCleanHttpServer(): Promise<RunningServer> {
  return startSessionAwareServer((mcp) => registerEcho(mcp));
}

/**
 * The same "echo" tool for every session, plus a second tool that only
 * exists from the SECOND independently-initialized session onward. `runLitmus`
 * grades through the first session; the litmus-v17 same-session recheck opens
 * the second, so this simulates a target whose tool surface changed within
 * one grading session.
 */
function startDriftingHttpServer(): Promise<RunningServer> {
  return startSessionAwareServer((mcp, sessionOrdinal) => {
    registerEcho(mcp);
    if (sessionOrdinal > 1) {
      mcp.registerTool(
        "extra_tool",
        { title: "Extra", description: "Appeared after the first session.", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "unused" }] }),
      );
    }
  });
}

describe("runLitmus: remote http honesty (litmus-v17)", () => {
  const prevAllow = process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS;

  afterEach(() => {
    if (prevAllow === undefined) delete process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS;
    else process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS = prevAllow;
  });

  it("grades a clean remote target B, with C-02 AND C-03 both recorded not-verified", async () => {
    process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS = "1";
    const srv = await startCleanHttpServer();
    try {
      const bundle = await runLitmus(srv.url);
      expect(bundle.grade).toBe("B");

      const c02 = bundle.categories.find((c) => c.code === "C-02");
      const c03 = bundle.categories.find((c) => c.code === "C-03");
      expect(c02?.status).toBe("skipped");
      expect(c03?.status).toBe("skipped");
      expect(bundle.gradeRationale).toContain("C-02");
      expect(bundle.gradeRationale).toContain("C-03");

      // Probe 4.1 records the honest reason rather than a silent pass.
      const p41 = c03?.probes.find((p) => p.id === "4.1");
      expect(p41?.status).toBe("skipped");
      expect(p41?.reason).toMatch(/no canary could be planted on a remote target/);

      // The presented client identity is recorded, never the old fixed string.
      expect(bundle.harness.presentedClientInfo?.name).toBeTruthy();
      expect(bundle.harness.presentedClientInfo?.name).not.toBe("polygraph-litmus");

      // A stable surface across the grading connect and the recheck connect
      // never fires the advisory.
      expect(bundle.surfaceConsistency).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("flags a same-session surface-drift advisory without moving the grade", async () => {
    process.env.POLYGRAPH_ALLOW_PRIVATE_TARGETS = "1";
    const srv = await startDriftingHttpServer();
    try {
      const bundle = await runLitmus(srv.url);
      expect(bundle.grade).toBe("B"); // unchanged despite the drift
      expect(bundle.surfaceConsistency?.kind).toBe("surface-drift");
      expect(bundle.surfaceConsistency?.context).toContain("graded=");
      expect(bundle.surfaceConsistency?.context).toContain("recheck=");
    } finally {
      await srv.close();
    }
  }, 30_000);
});
