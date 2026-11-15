import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaunchBanner, safeBackUrl } from "./LaunchBanner";
import { useLaunchSessionStore } from "./launch-session-store";
import type { LaunchSession } from "./launch-session";

const good: LaunchSession = {
  v: 1,
  app: "nremote-builder",
  label: "N-Remote Builder",
  returnUrl: "https://buildnow.n-remote.com/api/video-editor/deliver/init",
  token: "t",
  maxBytes: 52428800,
};

describe("LaunchBanner", () => {
  beforeEach(() => {
    useLaunchSessionStore.getState().clear();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders nothing without a session or refusal", () => {
    render(<LaunchBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows Editing for <label> and a back link when backUrl is set", () => {
    useLaunchSessionStore.getState().setSession({
      ...good,
      backUrl: "https://buildnow.n-remote.com/visual-editor/p1",
    });
    render(<LaunchBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("Editing for N-Remote Builder");
    expect(screen.getByRole("link", { name: /back to N-Remote Builder/i })).toHaveAttribute(
      "href",
      "https://buildnow.n-remote.com/visual-editor/p1",
    );
  });

  it("does not render a back link for a javascript: backUrl", () => {
    useLaunchSessionStore.getState().setSession({ ...good, backUrl: "javascript:alert(1)" });
    render(<LaunchBanner />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Editing for N-Remote Builder");
  });

  it("shows the refusal message when the launch was refused", () => {
    useLaunchSessionStore.getState().setRefusal("origin-not-allowed");
    render(<LaunchBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "N-Remote Video could not start the session from this link: the calling app is not allowed (origin-not-allowed).",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useLaunchSessionStore.getState().refusal).toBeNull();
  });
});

describe("LaunchBanner refusal wording", () => {
  beforeEach(() => {
    useLaunchSessionStore.getState().clear();
  });
  afterEach(() => {
    cleanup();
  });

  it.each([
    ["expired", "the link has expired (expired)"],
    ["malformed", "the link is not valid (malformed)"],
    ["invalid-fields", "the link is not valid (invalid-fields)"],
    ["unsupported-version", "the link is not valid (unsupported-version)"],
  ] as const)("maps %s to plain words with the code in parentheses", (code, words) => {
    useLaunchSessionStore.getState().setRefusal(code);
    render(<LaunchBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent(words);
  });

  it("puts the full text in a title on the truncating span (refusal and session)", () => {
    useLaunchSessionStore.getState().setRefusal("expired");
    const { unmount } = render(<LaunchBanner />);
    const span = screen.getByRole("alert").querySelector("span.truncate");
    expect(span?.getAttribute("title")).toBe(span?.textContent);
    unmount();
    useLaunchSessionStore.getState().setSession(good);
    render(<LaunchBanner />);
    const s2 = screen.getByRole("status").querySelector("span.truncate");
    expect(s2?.getAttribute("title")).toBe("Editing for N-Remote Builder");
  });
});

describe("safeBackUrl", () => {
  it("accepts http(s) and rejects everything else", () => {
    expect(safeBackUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeBackUrl("http://a.example/x")).toBe("http://a.example/x");
    expect(safeBackUrl("javascript:alert(1)")).toBeNull();
    expect(safeBackUrl("data:text/html,x")).toBeNull();
    expect(safeBackUrl("not a url")).toBeNull();
    expect(safeBackUrl(undefined)).toBeNull();
  });
});
