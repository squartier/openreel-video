import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchSession } from "./launch-session";
import { useLaunchSessionStore } from "./launch-session-store";
import type { SendMeta } from "./sender";
import { useSendStore, type SendState } from "./send-store";
import { SendResultDialog } from "./SendResultDialog";

vi.mock("./send-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send-flow")>();
  return { ...actual, startSend: vi.fn(async () => undefined) };
});
import { startSend } from "./send-flow";

const good: LaunchSession = {
  v: 1,
  app: "nremote-builder",
  label: "N-Remote Builder",
  returnUrl: "https://buildnow.n-remote.com/api/video-editor/deliver/init",
  token: "t",
  maxBytes: 52428800,
};
const meta: SendMeta = {
  filename: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 2,
  durationSec: 3,
  width: 1920,
  height: 1080,
};
const file = new Blob(["ab"], { type: "video/mp4" });

const sending: SendState = { status: "sending", phase: "upload", fraction: 0.42, file, filename: "clip.mp4", meta };
const sent: SendState = { status: "sent", message: "Added to your media library", file, filename: "clip.mp4" };
const failed: SendState = {
  status: "failed",
  failure: { kind: "network", phase: "upload", message: "Upload failed (network)" },
  file,
  filename: "clip.mp4",
  meta,
};
const expired: SendState = {
  status: "failed",
  failure: { kind: "expired", phase: "init", message: "Your session has expired", status: 401 },
  file,
  filename: "clip.mp4",
  meta,
};

function show(state: SendState, session: LaunchSession = good) {
  useLaunchSessionStore.getState().setSession(session);
  useSendStore.getState().set(state);
  return render(<SendResultDialog />);
}

describe("SendResultDialog", () => {
  beforeEach(() => {
    useLaunchSessionStore.getState().clear();
    useSendStore.getState().reset();
    vi.mocked(startSend).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when idle", () => {
    useLaunchSessionStore.getState().setSession(good);
    render(<SendResultDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the upload progress while sending", () => {
    show(sending);
    expect(screen.getByRole("dialog")).toHaveTextContent("Sending to N-Remote Builder");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Uploading… 42%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("on success shows the message and Back to <label>", () => {
    show(sent, { ...good, backUrl: "https://buildnow.n-remote.com/projects/1" });
    expect(screen.getByText("Added to your media library")).toBeInTheDocument();
    const back = screen.getByRole("link", { name: "Back to N-Remote Builder" });
    expect(back).toHaveAttribute("href", "https://buildnow.n-remote.com/projects/1");
    expect(back).not.toHaveAttribute("target");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("on success shows no Back link when backUrl is missing or not http(s)", () => {
    show(sent, { ...good, backUrl: "javascript:alert(1)" });
    expect(screen.queryByRole("link", { name: /Back to/ })).toBeNull();
    cleanup();
    show(sent);
    expect(screen.queryByRole("link", { name: /Back to/ })).toBeNull();
  });

  it("on failure shows the message, Retry and Download", () => {
    show(failed);
    expect(screen.getByText("Upload failed (network)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(startSend).toHaveBeenCalledWith(good, file, "clip.mp4", meta);
  });

  it("on expired shows the expired copy and no Retry", () => {
    show(expired);
    expect(
      screen.getByText(
        "Your session for N-Remote Builder has expired — download the file and upload it there.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("Download triggers an anchor download of the kept file in every non-idle state", () => {
    const create = vi.fn(() => "blob:kept");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    for (const state of [sending, sent, failed, expired]) {
      show(state);
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      cleanup();
    }

    expect(create).toHaveBeenCalledTimes(4);
    for (const call of create.mock.calls as unknown as [Blob][]) expect(call[0]).toBe(file);
    expect(click).toHaveBeenCalledTimes(4);
  });

  it("Close resets the send store", () => {
    show(failed);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useSendStore.getState().status).toBe("idle");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("follows the store from sending to sent", () => {
    show(sending);
    act(() => useSendStore.getState().set(sent));
    expect(screen.getByText("Added to your media library")).toBeInTheDocument();
  });
});
