import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { sameOriginAuthFetch } from "./auth-fetch.js";

/** An ephemeral localhost server that echoes back the Authorization it saw. */
function echoServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ auth: req.headers["authorization"] ?? null }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe("sameOriginAuthFetch", () => {
  it("sends auth headers to the target origin", async () => {
    const target = await echoServer();
    try {
      const f = sameOriginAuthFetch(target.url, { Authorization: "Bearer secret" });
      const res = await f(target.url, { headers: { Authorization: "Bearer secret" } });
      expect(((await res.json()) as { auth: string | null }).auth).toBe("Bearer secret");
    } finally {
      target.close();
    }
  });

  it("strips auth headers on a cross-origin request (token-leak guard)", async () => {
    const target = await echoServer();
    const other = await echoServer(); // distinct port → distinct origin
    try {
      const f = sameOriginAuthFetch(target.url, { Authorization: "Bearer secret" });
      const res = await f(other.url, { headers: { Authorization: "Bearer secret" } });
      expect(((await res.json()) as { auth: string | null }).auth).toBeNull();
    } finally {
      target.close();
      other.close();
    }
  });
});
