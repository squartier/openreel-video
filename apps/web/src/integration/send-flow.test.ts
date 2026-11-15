import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchSession } from "./launch-session";
import type { SendDeps, SendMeta } from "./sender";
import { useSendStore } from "./send-store";
import { cancelSend, checkSendSize, downloadKeptFile, sendDeliveryOptions, startSend } from "./send-flow";
import { useLaunchSessionStore } from "./launch-session-store";
import { toast } from "../stores/notification-store";

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
const UPLOAD_URL = "https://qvedzwdlpdhzoumuxcsc.supabase.co/storage/u";
const COMPLETE_URL = "https://buildnow.n-remote.com/api/video-editor/deliver/complete";

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 200;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open() {}
  setRequestHeader() {}
  send() {
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.onload?.();
    });
  }
}

const deps = (fetchFn: (...args: never[]) => unknown): SendDeps => ({
  fetchFn: fetchFn as unknown as SendDeps["fetchFn"],
  xhrFactory: () => new FakeXhr() as unknown as XMLHttpRequest,
  allowedUploadOrigins: ["https://qvedzwdlpdhzoumuxcsc.supabase.co"],
});

const initOk = () =>
  res(200, { ok: true, upload: { url: UPLOAD_URL, method: "PUT", headers: {} }, completeUrl: COMPLETE_URL });

const file = new Blob(["ab"], { type: "video/mp4" });

beforeEach(() => {
  useSendStore.getState().reset();
  FakeXhr.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkSendSize", () => {
  it("refuses to send above maxBytes", () => expect(checkSendSize({ ...good, maxBytes: 10 }, 11).ok).toBe(false));

  it("accepts a file at or below maxBytes, and any size without maxBytes", () => {
    expect(checkSendSize({ ...good, maxBytes: 10 }, 10).ok).toBe(true);
    expect(checkSendSize({ ...good, maxBytes: undefined }, 10 ** 12).ok).toBe(true);
  });

  it("explains the refusal in MB with one decimal", () => {
    const r = checkSendSize(good, 60 * 1024 * 1024);
    expect(r).toEqual({
      ok: false,
      message: "This export is 60.0 MB; N-Remote Builder accepts at most 50.0 MB. Download it instead.",
    });
  });
});

describe("startSend", () => {
  it("moves the store sending → sent on success", async () => {
    const seen: string[] = [];
    const unsub = useSendStore.subscribe((s) => seen.push(s.status));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(initOk())
      .mockResolvedValueOnce(res(200, { ok: true, url: "https://x/v.mp4", message: "Added to your media library" }));

    await startSend(good, file, "clip.mp4", meta, deps(fetchFn));
    unsub();

    expect(seen[0]).toBe("sending");
    const s = useSendStore.getState();
    expect(s.status).toBe("sent");
    if (s.status !== "sent") throw new Error("unreachable");
    expect(s.message).toBe("Added to your media library");
    expect(s.url).toBe("https://x/v.mp4");
    expect(s.file).toBe(file);
    expect(s.filename).toBe("clip.mp4");
  });

  it("reports upload progress into the store while sending", async () => {
    const fractions: number[] = [];
    const unsub = useSendStore.subscribe((s) => {
      if (s.status === "sending" && s.phase === "upload") fractions.push(s.fraction);
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(initOk()).mockResolvedValueOnce(res(200, { ok: true }));
    await startSend(good, file, "clip.mp4", meta, deps(fetchFn));
    unsub();
    expect(fractions).toContain(0.5);
  });

  it("moves the store to failed with the failure on error", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(401, { ok: false }));
    await startSend(good, file, "clip.mp4", meta, deps(fetchFn));
    const s = useSendStore.getState();
    expect(s.status).toBe("failed");
    if (s.status !== "failed") throw new Error("unreachable");
    expect(s.failure.kind).toBe("expired");
    expect(s.failure.phase).toBe("init");
    expect(s.file).toBe(file);
    expect(s.meta).toEqual(meta);
  });

  it("turns an unexpected throw into a failed network state instead of rejecting", async () => {
    const throwingDeps = {
      ...deps(vi.fn()),
      get fetchFn(): never {
        throw new Error("boom");
      },
    };
    await expect(startSend(good, file, "clip.mp4", meta, throwingDeps)).resolves.toBeUndefined();
    const s = useSendStore.getState();
    expect(s.status).toBe("failed");
    if (s.status !== "failed") throw new Error("unreachable");
    expect(s.failure.kind).toBe("network");
    expect(s.file).toBe(file);
  });

  it("retry restarts from init (even when the first attempt got as far as complete)", async () => {
    // First attempt: init and upload succeed, complete fails.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(initOk())
      .mockResolvedValueOnce(res(500, { ok: false, message: "down" }));
    await startSend(good, file, "clip.mp4", meta, deps(fetchFn));
    const first = useSendStore.getState();
    expect(first.status).toBe("failed");
    if (first.status !== "failed") throw new Error("unreachable");
    expect(first.failure.phase).toBe("complete");
    expect(FakeXhr.instances).toHaveLength(1);

    fetchFn.mockResolvedValueOnce(initOk()).mockResolvedValueOnce(res(200, { ok: true }));
    await startSend(good, file, "clip.mp4", meta, deps(fetchFn));

    const urls = fetchFn.mock.calls.map(([url]) => url);
    expect(urls).toEqual([good.returnUrl, COMPLETE_URL, good.returnUrl, COMPLETE_URL]);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(useSendStore.getState().status).toBe("sent");
  });
});

describe("generation guard", () => {
  it("a superseded send cannot overwrite the newer send's state", async () => {
    let resolveA: (v: unknown) => void = () => undefined;
    const fetchA = vi.fn(() => new Promise((r) => { resolveA = r; }));
    const fileA = new Blob(["a"], { type: "video/mp4" });
    const fileB = new Blob(["bb"], { type: "video/mp4" });
    const sendA = startSend(good, fileA, "a.mp4", meta, deps(fetchA));

    const fetchB = vi.fn(() => new Promise<never>(() => undefined));
    void startSend(good, fileB, "b.mp4", meta, deps(fetchB));

    resolveA(res(401, { ok: false }));
    await sendA;

    const s = useSendStore.getState();
    expect(s.status).toBe("sending");
    if (s.status !== "sending") throw new Error("unreachable");
    expect(s.file).toBe(fileB);
    expect(s.filename).toBe("b.mp4");
  });
});

describe("cancelSend", () => {
  class HangingXhr extends FakeXhr {
    aborted = false;
    send() {}
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }

  it("cancel during upload resets to idle; a late tick from the aborted send cannot reopen the dialog", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(initOk());
    const pending = startSend(good, file, "clip.mp4", meta, {
      ...deps(fetchFn),
      xhrFactory: () => new HangingXhr() as unknown as XMLHttpRequest,
    });
    await vi.waitFor(() => {
      const s = useSendStore.getState();
      expect(s.status === "sending" && s.phase === "upload").toBe(true);
    });
    const xhr = FakeXhr.instances[0] as HangingXhr;

    cancelSend();
    expect(useSendStore.getState().status).toBe("idle");
    expect(xhr.aborted).toBe(true);

    // A late progress tick (and the aborted send's own failure) must not write.
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    await pending;
    expect(useSendStore.getState().status).toBe("idle");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op reset when nothing is sending", () => {
    expect(() => cancelSend()).not.toThrow();
    expect(useSendStore.getState().status).toBe("idle");
  });
});

describe("downloadKeptFile", () => {
  it("clicks an anchor with an object URL and revokes it later", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:kept");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href).toBe("blob:kept");
      expect(this.download).toBe("clip.mp4");
    });

    downloadKeptFile(file, "clip.mp4");

    expect(create).toHaveBeenCalledWith(file);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:kept");
    vi.useRealTimers();
  });
});

describe("sendDeliveryOptions (the guarded onFile)", () => {
  const project = { settings: { width: 1280, height: 720 }, timeline: { duration: 12 } };

  beforeEach(() => {
    useLaunchSessionStore.getState().setSession(good);
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:kept"), revokeObjectURL: vi.fn() });
  });

  it("asks the sink for send delivery with an onFile handler", () => {
    const opts = sendDeliveryOptions("mp4", { width: 1920, height: 1080 }, project);
    expect(opts.delivery).toBe("send");
    expect(typeof opts.onFile).toBe("function");
  });

  it("refuses a file above maxBytes: toast + download, no send store change", () => {
    useLaunchSessionStore.getState().setSession({ ...good, maxBytes: 1 });
    const err = vi.spyOn(toast, "error").mockImplementation(() => undefined as never);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    sendDeliveryOptions("mp4", { width: 1920, height: 1080 }, project).onFile(file, "clip.mp4");
    expect(err).toHaveBeenCalledWith(
      "Too large to send",
      "This export is 0.0 MB; N-Remote Builder accepts at most 0.0 MB. Download it instead.",
    );
    expect(click).toHaveBeenCalledTimes(1);
    expect(useSendStore.getState().status).toBe("idle");
  });

  it("starts the send with meta from the settings, the file and the range", () => {
    const fetchFn = vi.fn(() => new Promise<never>(() => undefined));
    vi.stubGlobal("fetch", fetchFn);
    sendDeliveryOptions("webm", { width: 1920, height: 1080, range: { startTime: 2, endTime: 5 } }, project).onFile(
      file,
      "clip.webm",
    );
    const s = useSendStore.getState();
    expect(s.status).toBe("sending");
    if (s.status !== "sending") throw new Error("unreachable");
    expect(s.meta).toEqual({
      filename: "clip.webm",
      mimeType: "video/webm",
      sizeBytes: 2,
      durationSec: 3,
      width: 1920,
      height: 1080,
    });
    vi.unstubAllGlobals();
  });

  it("falls back to the project's size and timeline duration", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<never>(() => undefined)));
    sendDeliveryOptions("mp4", {}, project).onFile(file, "clip.mp4");
    const s = useSendStore.getState();
    if (s.status !== "sending") throw new Error("unreachable");
    expect(s.meta).toMatchObject({ width: 1280, height: 720, durationSec: 12 });
    vi.unstubAllGlobals();
  });

  it("downloads instead when the session is gone", () => {
    useLaunchSessionStore.getState().clear();
    const info = vi.spyOn(toast, "info").mockImplementation(() => undefined as never);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    sendDeliveryOptions("mp4", {}, project).onFile(file, "clip.mp4");
    expect(click).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Session ended", "The video was downloaded instead of sent.");
    expect(useSendStore.getState().status).toBe("idle");
  });

  it("never throws: a synchronous failure becomes a failed network state at init", () => {
    useLaunchSessionStore.getState().setSession({ ...good, maxBytes: 1 });
    vi.spyOn(toast, "error").mockImplementation(() => {
      throw new Error("toast broke");
    });
    expect(() => sendDeliveryOptions("mp4", {}, project).onFile(file, "clip.mp4")).not.toThrow();
    const s = useSendStore.getState();
    expect(s.status).toBe("failed");
    if (s.status !== "failed") throw new Error("unreachable");
    expect(s.failure).toMatchObject({ kind: "network", phase: "init" });
    expect(s.file).toBe(file);
    expect(s.filename).toBe("clip.mp4");
  });

  it("the synchronous failure supersedes an older in-flight send (generation-guarded)", async () => {
    let resolveA: (v: unknown) => void = () => undefined;
    const fetchA = vi.fn(() => new Promise((r) => { resolveA = r; }));
    const fileA = new Blob(["a"], { type: "video/mp4" });
    const sendA = startSend(good, fileA, "a.mp4", meta, deps(fetchA));

    useLaunchSessionStore.getState().setSession({ ...good, maxBytes: 1 });
    vi.spyOn(toast, "error").mockImplementation(() => {
      throw new Error("toast broke");
    });
    sendDeliveryOptions("mp4", {}, project).onFile(file, "clip.mp4");

    resolveA(res(401, { ok: false }));
    await sendA;

    const s = useSendStore.getState();
    expect(s.status).toBe("failed");
    if (s.status !== "failed") throw new Error("unreachable");
    expect(s.file).toBe(file);
    expect(s.filename).toBe("clip.mp4");
    expect(s.failure.message).toBe("toast broke");
  });
});
