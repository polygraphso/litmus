import { describe, it, expect, afterEach } from "vitest";
import { apiBaseUrl, pinUrl, mintUrl } from "./api.js";

const ORIG = process.env.POLYGRAPH_API_URL;
afterEach(() => {
  if (ORIG === undefined) delete process.env.POLYGRAPH_API_URL;
  else process.env.POLYGRAPH_API_URL = ORIG;
});

describe("cli api urls", () => {
  it("defaults to the live site; honors the override and strips a trailing slash", () => {
    delete process.env.POLYGRAPH_API_URL;
    expect(apiBaseUrl()).toBe("https://polygraph.so");
    process.env.POLYGRAPH_API_URL = "http://localhost:3000/";
    expect(apiBaseUrl()).toBe("http://localhost:3000");
    expect(pinUrl()).toBe("http://localhost:3000/api/pin");
  });

  it("builds the mint deep-link with cid / ref / fp", () => {
    process.env.POLYGRAPH_API_URL = "http://localhost:3000";
    const u = new URL(mintUrl({ cid: "bafyCID", ref: "npm/@s/x", fp: "0xabc" }));
    expect(u.pathname).toBe("/mint");
    expect(u.searchParams.get("cid")).toBe("bafyCID");
    expect(u.searchParams.get("ref")).toBe("npm/@s/x");
    expect(u.searchParams.get("fp")).toBe("0xabc");
    // no version → no ver param
    expect(u.searchParams.has("ver")).toBe(false);
  });

  it("includes ver in the mint deep-link when a resolved version is given", () => {
    process.env.POLYGRAPH_API_URL = "http://localhost:3000";
    const u = new URL(mintUrl({ cid: "bafyCID", ref: "npm/@s/x", fp: "0xabc", ver: "1.2.3" }));
    expect(u.searchParams.get("ver")).toBe("1.2.3");
    // a null version is omitted, not serialized as "null"
    const u2 = new URL(mintUrl({ cid: "bafyCID", ref: "npm/@s/x", fp: "0xabc", ver: null }));
    expect(u2.searchParams.has("ver")).toBe(false);
  });
});
