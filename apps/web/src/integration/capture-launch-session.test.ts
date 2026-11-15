import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureLaunchSession } from "./capture-launch-session";
import {
  useLaunchSessionStore,
  resetIntegrationEnvForTests,
} from "./launch-session-store";
import type { LaunchSession } from "./launch-session";

const enc = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const good: LaunchSession = {
  v: 1,
  app: "nremote-builder",
  label: "N-Remote Builder",
  returnUrl: "https://buildnow.n-remote.com/api/video-editor/deliver/init",
  token: "t",
  maxBytes: 52428800,
};
const makeWin = (search: string, replaceState = vi.fn()) =>
  ({
    location: { search, pathname: "/", hash: "#/editor" },
    history: { replaceState },
  }) as never;

beforeEach(() => {
  resetIntegrationEnvForTests({
    allowedReturnOrigins: ["https://buildnow.n-remote.com"],
  });
  useLaunchSessionStore.getState().clear();
  sessionStorage.clear();
});

describe("captureLaunchSession", () => {
  it("stores a valid session and strips the param from the URL", () => {
    const replaceState = vi.fn();
    captureLaunchSession(makeWin(`?launch=${enc(good)}`, replaceState), useLaunchSessionStore);
    const s = useLaunchSessionStore.getState();
    expect(s.session?.app).toBe("nremote-builder");
    expect(s.refusal).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/#/editor");
  });

  it("records a refusal, stores no session and clears a stale one", () => {
    useLaunchSessionStore.getState().setSession(good);
    const replaceState = vi.fn();
    const bad = { ...good, returnUrl: "https://evil.example/x" };
    captureLaunchSession(makeWin(`?launch=${enc(bad)}`, replaceState), useLaunchSessionStore);
    const s = useLaunchSessionStore.getState();
    expect(s.session).toBeNull();
    expect(s.refusal).toBe("origin-not-allowed");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/#/editor");
  });

  it("leaves an existing session alone when no param is present", () => {
    useLaunchSessionStore.getState().setSession(good);
    const replaceState = vi.fn();
    captureLaunchSession(makeWin("", replaceState), useLaunchSessionStore);
    expect(useLaunchSessionStore.getState().session).toEqual(good);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("session survives reload in the same tab", () => {
    useLaunchSessionStore.getState().setSession(good);
    const raw = sessionStorage.getItem("nremote-launch-session");
    expect(raw).toContain("nremote-builder");
    expect(raw).not.toContain("setSession");
  });
});
