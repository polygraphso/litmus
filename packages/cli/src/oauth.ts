/**
 * OAuth-assist: fetch an access token for a token-gated MCP server by driving the
 * standard MCP OAuth 2.1 authorization-code + PKCE flow via the SDK's own client.
 *
 * This is a CLI-layer convenience. It opens the user's browser to authorize, captures
 * the redirect on a single-use 127.0.0.1 loopback listener, and returns the access
 * token for the caller to use as a bearer for that one grade run. The token is held in
 * memory only — never written to disk.
 *
 * This module must NEVER be imported by the harness / `runLitmus`: a hosted runner must
 * not open a browser or run an interactive flow. It is wired in only at the CLI entry
 * and the MCP tool handler.
 */
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const CLIENT_NAME = "polygraph-litmus";

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>polygraph</title>' +
  '<body style="font-family:system-ui;padding:2rem;max-width:32rem">' +
  "<h3>Authorization received</h3><p>You can close this tab and return to the terminal.</p></body>";

/**
 * In-memory `OAuthClientProvider` for a one-shot interactive grade. Holds the DCR
 * result, the PKCE verifier, and the tokens in memory; never persists anything.
 */
export class LoopbackOAuthProvider implements OAuthClientProvider {
  /** CSRF state, generated once; validated against the callback's `state`. */
  readonly issuedState = randomUUID();
  private _clientInfo?: OAuthClientInformationMixed;
  private _codeVerifier?: string;
  private _tokens?: OAuthTokens;

  constructor(
    private readonly _redirectUrl: string,
    private readonly _onRedirect: (url: URL) => void | Promise<void>,
    private readonly _clientName: string = CLIENT_NAME,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this._clientName,
      redirect_uris: [this._redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  state(): string {
    return this.issuedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInfo;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  saveCodeVerifier(verifier: string): void {
    this._codeVerifier = verifier;
  }
  codeVerifier(): string {
    if (!this._codeVerifier) throw new Error("PKCE code verifier missing");
    return this._codeVerifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this._onRedirect(authorizationUrl);
  }
}

/** Parsed loopback callback. */
export interface CallbackParams {
  code: string;
  state: string | null;
}

/**
 * Parse a loopback `/callback?code&state` request URL. Returns null for a wrong path
 * or a missing `code`.
 */
export function parseCallbackParams(reqUrl: string): CallbackParams | null {
  let u: URL;
  try {
    u = new URL(reqUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (u.pathname !== CALLBACK_PATH) return null;
  const code = u.searchParams.get("code");
  if (!code) return null;
  return { code, state: u.searchParams.get("state") };
}

export interface CallbackServer {
  /** The loopback redirect URI to register and redirect to. */
  redirectUrl: string;
  /** Resolve with the captured params, or null on timeout. Buffers a callback that
   *  arrives before this is called, so there is no race with the browser redirect. */
  waitForCode(timeoutMs: number): Promise<CallbackParams | null>;
  close(): void;
}

/** Start a single-use loopback listener on 127.0.0.1 for the OAuth redirect. */
export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve) => {
    let pending: CallbackParams | null | undefined;
    let deliver: ((r: CallbackParams | null) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const server: Server = createServer((req, res) => {
      const parsed = req.url ? parseCallbackParams(req.url) : null;
      if (!parsed) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SUCCESS_HTML);
      if (deliver) deliver(parsed);
      else pending = parsed;
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        waitForCode(timeoutMs: number) {
          if (pending !== undefined) {
            const r = pending;
            pending = undefined;
            return Promise.resolve(r);
          }
          return new Promise((res2) => {
            timer = setTimeout(() => {
              deliver = null;
              timer = null;
              res2(null);
            }, timeoutMs);
            deliver = (r) => {
              if (timer) clearTimeout(timer);
              timer = null;
              res2(r);
            };
          });
        },
        close() {
          if (timer) clearTimeout(timer);
          timer = null;
          deliver = null;
          server.close();
        },
      });
    });
  });
}

/** Open a URL in the user's default browser (best-effort; native, no dependency). */
export function defaultOpenBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  // Best-effort: errors are ignored because the URL is also surfaced to the user.
  execFile(cmd, args, () => {});
}

export interface AcquireOAuthOptions {
  timeoutMs?: number;
  /** Open the authorization URL (defaults to the platform browser). Injectable for tests. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Called with the authorization URL so the caller can surface it (print / notify). */
  onAuthUrl?: (url: string) => void;
  clientName?: string;
}

/**
 * Drive the MCP OAuth authorization-code + PKCE flow for `targetUrl` and return the
 * access token, or null if the server is not OAuth, the user declines, the `state`
 * mismatches, or it times out. A browser is opened only once discovery succeeds — a
 * non-OAuth 401 fails discovery before `redirectToAuthorization`, so nothing opens.
 */
export async function acquireOAuthToken(targetUrl: string, opts: AcquireOAuthOptions = {}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  const server = await startCallbackServer();
  const provider = new LoopbackOAuthProvider(
    server.redirectUrl,
    async (url) => {
      opts.onAuthUrl?.(url.toString());
      await openBrowser(url.toString());
    },
    opts.clientName,
  );
  const transport = new StreamableHTTPClientTransport(new URL(targetUrl), { authProvider: provider });
  const client = new Client({ name: CLIENT_NAME, version: "0.0.0" }, {});
  try {
    try {
      await client.connect(transport);
      // Connected without interaction (already authorized) — return any token we have.
      return (await provider.tokens())?.access_token ?? null;
    } catch (err) {
      // Anything other than "needs authorization" (e.g. not an OAuth server, discovery
      // failed) means we can't help — fall back without opening anything further.
      if (!(err instanceof UnauthorizedError)) return null;
    }
    // `redirectToAuthorization` has fired (browser opened); wait for the redirect.
    const cb = await server.waitForCode(timeoutMs);
    if (!cb || cb.state !== provider.issuedState) return null; // timeout or CSRF mismatch
    await transport.finishAuth(cb.code);
    return (await provider.tokens())?.access_token ?? null;
  } catch {
    return null;
  } finally {
    server.close();
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}
