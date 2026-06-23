import { describe, it, expect } from "vitest";
import { LoopbackOAuthProvider, parseCallbackParams, startCallbackServer } from "./oauth.js";

describe("LoopbackOAuthProvider", () => {
  it("advertises public-client metadata for DCR (loopback redirect, none, PKCE grants)", () => {
    const p = new LoopbackOAuthProvider("http://127.0.0.1:8976/callback", () => {});
    const m = p.clientMetadata;
    expect(m.redirect_uris.map(String)).toEqual(["http://127.0.0.1:8976/callback"]);
    expect(m.token_endpoint_auth_method).toBe("none");
    expect(m.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(m.response_types).toEqual(["code"]);
    expect(m.client_name).toBe("polygraph-litmus");
  });

  it("returns a stable, non-empty state used for CSRF validation", () => {
    const p = new LoopbackOAuthProvider("http://127.0.0.1:1/callback", () => {});
    expect(p.state()).toBe(p.issuedState);
    expect(p.issuedState.length).toBeGreaterThan(0);
  });

  it("redirectToAuthorization forwards the URL to the injected handler (browser open)", async () => {
    const seen: string[] = [];
    const p = new LoopbackOAuthProvider("http://127.0.0.1:1/callback", (u) => {
      seen.push(u.toString());
    });
    await p.redirectToAuthorization(new URL("https://as.example/authorize?x=1"));
    expect(seen).toEqual(["https://as.example/authorize?x=1"]);
  });

  it("round-trips the PKCE verifier and tokens it is given", () => {
    const p = new LoopbackOAuthProvider("http://127.0.0.1:1/callback", () => {});
    p.saveCodeVerifier("v123");
    expect(p.codeVerifier()).toBe("v123");
    expect(p.tokens()).toBeUndefined();
    p.saveTokens({ access_token: "tok", token_type: "Bearer" });
    expect(p.tokens()?.access_token).toBe("tok");
  });
});

describe("parseCallbackParams", () => {
  it("parses code and state from the callback path", () => {
    expect(parseCallbackParams("/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it("returns null for the wrong path or a missing code", () => {
    expect(parseCallbackParams("/other?code=abc")).toBeNull();
    expect(parseCallbackParams("/callback?state=xyz")).toBeNull();
  });
});

describe("startCallbackServer", () => {
  it("resolves waitForCode when the browser hits /callback", async () => {
    const server = await startCallbackServer();
    try {
      const wait = server.waitForCode(5000);
      const res = await fetch(`${server.redirectUrl}?code=THECODE&state=THESTATE`);
      expect(res.status).toBe(200);
      await expect(wait).resolves.toEqual({ code: "THECODE", state: "THESTATE" });
    } finally {
      server.close();
    }
  });

  it("buffers a callback that arrives before waitForCode is called (no race)", async () => {
    const server = await startCallbackServer();
    try {
      const res = await fetch(`${server.redirectUrl}?code=EARLY&state=S`);
      expect(res.status).toBe(200);
      await expect(server.waitForCode(5000)).resolves.toEqual({ code: "EARLY", state: "S" });
    } finally {
      server.close();
    }
  });

  it("times out to null when no callback arrives", async () => {
    const server = await startCallbackServer();
    try {
      await expect(server.waitForCode(50)).resolves.toBeNull();
    } finally {
      server.close();
    }
  });
});
