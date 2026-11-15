import { describe, it, expect } from "vitest";
import {
  parseLaunchSession,
  parseOriginList,
  isOriginAllowed,
  stripLaunchParam,
} from "./launch-session";

const ALLOWED = ["https://buildnow.n-remote.com"];
const enc = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const good = {
  v: 1,
  app: "nremote-builder",
  label: "N-Remote Builder",
  returnUrl: "https://buildnow.n-remote.com/api/video-editor/deliver/init",
  token: "t",
  maxBytes: 52428800,
};

describe("launch-session", () => {
  it("parses a valid launch param", () => {
    const r = parseLaunchSession(`?launch=${enc(good)}`, { allowedReturnOrigins: ALLOWED });
    expect(r).toEqual({ ok: true, session: good });
  });
  it("returns missing when there is no launch param", () =>
    expect(parseLaunchSession("?x=1", { allowedReturnOrigins: ALLOWED })).toEqual({
      ok: false,
      reason: "missing",
    }));
  it("returns malformed on bad base64 or non-JSON", () =>
    expect(parseLaunchSession("?launch=%%%", { allowedReturnOrigins: ALLOWED }).ok).toBe(false));
  it("refuses a returnUrl outside the allowlist", () =>
    expect(
      parseLaunchSession(`?launch=${enc({ ...good, returnUrl: "https://evil.example/x" })}`, {
        allowedReturnOrigins: ALLOWED,
      }),
    ).toEqual({ ok: false, reason: "origin-not-allowed" }));
  it("refuses v other than 1", () =>
    expect(
      parseLaunchSession(`?launch=${enc({ ...good, v: 2 })}`, { allowedReturnOrigins: ALLOWED }),
    ).toEqual({ ok: false, reason: "unsupported-version" }));
  it("refuses missing required keys", () =>
    expect(
      parseLaunchSession(`?launch=${enc({ v: 1, app: "a" })}`, { allowedReturnOrigins: ALLOWED }),
    ).toEqual({ ok: false, reason: "invalid-fields" }));
  it("refuses an expired session", () =>
    expect(
      parseLaunchSession(`?launch=${enc({ ...good, expiresAt: "2026-01-01T00:00:00Z" })}`, {
        allowedReturnOrigins: ALLOWED,
        now: new Date("2026-11-15T12:00:00Z"),
      }),
    ).toEqual({ ok: false, reason: "expired" }));
  it("allows http://localhost origins for development", () =>
    expect(isOriginAllowed("http://localhost:3000/api", ["http://localhost:3000"])).toBe(true));
  it("parseOriginList trims and drops empties", () =>
    expect(parseOriginList(" https://A.example ,, https://b.example/ ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]));
  it("stripLaunchParam removes only launch", () => {
    expect(stripLaunchParam("?launch=abc&x=1")).toBe("?x=1");
    expect(stripLaunchParam("?launch=abc")).toBe("");
  });
});
