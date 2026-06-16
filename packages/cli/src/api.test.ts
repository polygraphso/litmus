import { describe, it, expect, afterEach } from "vitest";
import { apiBaseUrl, attestationsUrl } from "./api.js";

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
    expect(attestationsUrl()).toBe("http://localhost:3000/api/attestations");
  });
});
