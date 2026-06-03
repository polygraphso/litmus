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
  });
});
