import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendExport, type SendMeta } from "./sender";
import type { LaunchSession } from "./launch-session";
import { resetIntegrationEnvForTests } from "./launch-session-store";

const session: LaunchSession = {
  v: 1,
  app: "builder",
  label: "N-Remote Builder",
  returnUrl: "https://app.example/api/return",
  token: "t",
};
const meta: SendMeta = {
  filename: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 2,
  durationSec: 3.5,
  width: 1920,
  height: 1080,
};
const UPLOAD_URL = "https://qvedzwdlpdhzoumuxcsc.supabase.co/storage/u";
const initBody = {
  ok: true,
  upload: { url: UPLOAD_URL, method: "PUT", headers: { "x-up": "1" } },
  completeUrl: "https://app.example/api/complete",
};

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new Error("not json");
    return body;
  },
});

class FakeXhr {
  static instances: FakeXhr[] = [];
  static nextStatus = 200;
  static mode: "ok" | "error" | "abort" = "ok";
  opened: [string, string] | null = null;
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.opened = [method, url];
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      if (FakeXhr.mode === "error") {
        this.onerror?.();
        return;
      }
      if (FakeXhr.mode === "abort") {
        this.onabort?.();
        return;
      }
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.status = FakeXhr.nextStatus;
      this.onload?.();
    });
  }
}

const xhrFactory = () => new FakeXhr() as unknown as XMLHttpRequest;
const file = new Blob(["ab"], { type: "video/mp4" });

beforeEach(() => {
  FakeXhr.instances = [];
  FakeXhr.nextStatus = 200;
  FakeXhr.mode = "ok";
  resetIntegrationEnvForTests({
    allowedUploadOrigins: ["https://qvedzwdlpdhzoumuxcsc.supabase.co"],
  });
});

describe("sendExport", () => {
  it("runs init, upload, complete with the exact bodies and headers", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, initBody))
      .mockResolvedValueOnce(res(200, { ok: true, url: "https://app.example/v/1" }));
    const progress = vi.fn();
    const result = await sendExport(session, file, meta, progress, {
      fetchFn,
      xhrFactory,
    });
    expect(result).toEqual({ ok: true, url: "https://app.example/v/1", message: undefined });

    const [url1, init1] = fetchFn.mock.calls[0];
    expect(url1).toBe(session.returnUrl);
    expect(init1.method).toBe("POST");
    expect(init1.headers).toEqual({
      Authorization: "Bearer t",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init1.body)).toEqual({
      v: 1,
      app: "builder",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2,
      durationSec: 3.5,
      width: 1920,
      height: 1080,
    });

    const xhr = FakeXhr.instances[0];
    expect(xhr.opened).toEqual(["PUT", UPLOAD_URL]);
    expect(xhr.headers).toEqual({ "x-up": "1" });
    expect(xhr.body).toBe(file);

    const [url2, init2] = fetchFn.mock.calls[1];
    expect(url2).toBe("https://app.example/api/complete");
    expect(init2.method).toBe("POST");
    expect(init2.headers).toEqual({
      Authorization: "Bearer t",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init2.body)).toEqual({
      v: 1,
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2,
      durationSec: 3.5,
      width: 1920,
      height: 1080,
    });

    expect(progress.mock.calls.map((c) => c[0])).toEqual([
      { phase: "init", fraction: 0 },
      { phase: "upload", fraction: 0 },
      { phase: "upload", fraction: 0.5 },
      { phase: "complete", fraction: 1 },
    ]);
  });

  it("refuses an upload target outside the allowlist", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      res(200, { ...initBody, upload: { url: "https://evil.example/u", method: "PUT" } }),
    );
    const factory = vi.fn(xhrFactory);
    const result = await sendExport(session, file, meta, vi.fn(), {
      fetchFn,
      xhrFactory: factory,
    });
    expect(result).toEqual({
      ok: false,
      kind: "upload-origin-not-allowed",
      phase: "upload",
      message:
        "N-Remote Builder asked the editor to upload to an address that is not allowed.",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps 401 at init to expired", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(401, { ok: false }));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toEqual({
      ok: false,
      kind: "expired",
      phase: "init",
      message: "Your session has expired",
      status: 401,
    });
  });

  it("maps { ok:false, message } at complete to refused with that message", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, initBody))
      .mockResolvedValueOnce(res(200, { ok: false, message: "Quota exceeded" }));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toMatchObject({
      ok: false,
      kind: "refused",
      phase: "complete",
      message: "Quota exceeded",
    });
  });

  it("maps 403 at complete to expired", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, initBody))
      .mockResolvedValueOnce(res(403, { ok: false }));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toMatchObject({ ok: false, kind: "expired", phase: "complete", status: 403 });
  });

  it("maps a non-JSON non-2xx to network with the status text", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(502, undefined));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toMatchObject({
      ok: false,
      kind: "network",
      phase: "init",
      message: "502 from init",
    });
  });

  it("maps a non-2xx JSON answer without message to refused with the status text", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(500, {}));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toMatchObject({ ok: false, kind: "refused", phase: "init", message: "500 from init" });
  });

  it("maps a failed PUT to network at phase upload", async () => {
    FakeXhr.nextStatus = 500;
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, initBody));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toEqual({
      ok: false,
      kind: "network",
      phase: "upload",
      message: "Upload failed (500)",
      status: 500,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("maps an XHR network error to network at phase upload", async () => {
    FakeXhr.mode = "error";
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, initBody));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toEqual({
      ok: false,
      kind: "network",
      phase: "upload",
      message: "Upload failed (network)",
    });
  });

  it("maps an XHR abort to network at phase upload", async () => {
    FakeXhr.mode = "abort";
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, initBody));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toEqual({
      ok: false,
      kind: "network",
      phase: "upload",
      message: "Upload failed (network)",
    });
  });

  it("refuses a completeUrl on another origin", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { ...initBody, completeUrl: "https://evil.example/done" }));
    const factory = vi.fn(xhrFactory);
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory: factory });
    expect(result).toEqual({
      ok: false,
      kind: "refused",
      phase: "init",
      message: "N-Remote Builder returned an invalid completion address.",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses an unparsable completeUrl", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, { ...initBody, completeUrl: "not a url" }));
    const factory = vi.fn(xhrFactory);
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory: factory });
    expect(result).toMatchObject({ ok: false, kind: "refused", phase: "init" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("defaults the upload method to PUT when absent", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { ok: true, upload: { url: UPLOAD_URL }, completeUrl: "https://app.example/c" }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(FakeXhr.instances[0].opened).toEqual(["PUT", UPLOAD_URL]);
  });

  it("refuses an init response without upload.url", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { ok: true, upload: {}, completeUrl: "https://app.example/c" }));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toEqual({
      ok: false,
      kind: "refused",
      phase: "init",
      message: "Invalid response from N-Remote Builder",
    });
  });

  it("maps a fetch rejection to network with Could not reach <label>", async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await sendExport(session, file, meta, vi.fn(), { fetchFn, xhrFactory });
    expect(result).toEqual({
      ok: false,
      kind: "network",
      phase: "init",
      message: "Could not reach N-Remote Builder",
    });
  });
});
