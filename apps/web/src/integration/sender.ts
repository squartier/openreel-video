import { isOriginAllowed, type LaunchSession } from "./launch-session";
import { integrationEnv } from "./launch-session-store";

export interface SendMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
}

export type SendPhase = "init" | "upload" | "complete";

export type SendFailure = {
  kind: "refused" | "expired" | "network" | "upload-origin-not-allowed";
  phase: SendPhase;
  message: string;
  status?: number;
};

export type SendResult =
  | { ok: true; url?: string; message?: string }
  | ({ ok: false } & SendFailure);

type FetchLike = (
  input: string,
  init?: Parameters<typeof fetch>[1],
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export interface SendDeps {
  fetchFn?: FetchLike;
  xhrFactory?: () => XMLHttpRequest;
  allowedUploadOrigins?: string[];
  /** Aborting it cancels the send: the in-flight fetch or XHR is abandoned (maps to network). */
  signal?: AbortSignal;
}

/** Init and complete each get this long before they count as unreachable. */
export const REQUEST_TIMEOUT_MS = 30_000;

type Progress = (p: { phase: SendPhase; fraction: number }) => void;

type Step<T> = { ok: true; value: T } | { ok: false; failure: SendFailure };

interface UploadTarget {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function fail(failure: SendFailure): { ok: false; failure: SendFailure } {
  return { ok: false, failure };
}

/**
 * A signal that aborts after `ms` or when `outer` aborts, whichever comes first
 * (a manual combiner: AbortSignal.any / AbortSignal.timeout are not everywhere,
 * and a plain setTimeout is cleared as soon as the request settles).
 * `aborted` rejects once the signal aborts, so a request that ignores the
 * signal still cannot hang the send.
 */
function deadline(ms: number, outer: AbortSignal | undefined) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  if (outer?.aborted) abort();
  else outer?.addEventListener("abort", abort, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(new Error("aborted"));
    else controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => undefined); // never an unhandled rejection
  return {
    signal: controller.signal,
    race: <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]),
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
    },
  };
}

/** POST JSON with the session token and map every failure per the contract. */
async function postJson(
  session: LaunchSession,
  fetchFn: FetchLike,
  phase: "init" | "complete",
  url: string,
  body: unknown,
  outerSignal: AbortSignal | undefined,
): Promise<Step<Record<string, unknown>>> {
  const limit = deadline(REQUEST_TIMEOUT_MS, outerSignal);
  try {
    return await postJsonWithin(session, fetchFn, phase, url, body, limit);
  } finally {
    limit.dispose();
  }
}

async function postJsonWithin(
  session: LaunchSession,
  fetchFn: FetchLike,
  phase: "init" | "complete",
  url: string,
  body: unknown,
  limit: ReturnType<typeof deadline>,
): Promise<Step<Record<string, unknown>>> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await limit.race(
      fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        // Never follow a redirect with the Bearer token (defence in depth).
        redirect: "error",
        signal: limit.signal,
      }),
    );
  } catch {
    // Network error, timeout, caller abort or a refused redirect.
    return fail({
      kind: "network",
      phase,
      message: `Could not reach ${session.label}`,
    });
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    return fail({
      kind: "expired",
      phase,
      message: "Your session has expired",
      status,
    });
  }

  let json: Record<string, unknown>;
  try {
    json = (await limit.race(response.json())) as Record<string, unknown>;
  } catch {
    return fail({
      kind: "network",
      phase,
      message: `${status} from ${phase}`,
      status,
    });
  }

  const ok = response.ok && json?.ok === true;
  if (!ok) {
    const message =
      typeof json?.message === "string" && json.message
        ? json.message
        : `${status} from ${phase}`;
    return fail({ kind: "refused", phase, message, status });
  }
  return { ok: true, value: json };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function runInit(
  session: LaunchSession,
  meta: SendMeta,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
): Promise<Step<{ upload: UploadTarget; completeUrl: string }>> {
  const step = await postJson(session, fetchFn, "init", session.returnUrl, {
    v: 1,
    app: session.app,
    filename: meta.filename,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
  }, signal);
  if (!step.ok) return step;

  const upload = step.value.upload as
    | { url?: unknown; method?: unknown; headers?: unknown }
    | undefined;
  const completeUrl = step.value.completeUrl;
  if (
    !upload ||
    typeof upload.url !== "string" ||
    !upload.url ||
    typeof completeUrl !== "string" ||
    !completeUrl
  ) {
    return fail({
      kind: "refused",
      phase: "init",
      message: `Invalid response from ${session.label}`,
    });
  }
  if (!sameOrigin(completeUrl, session.returnUrl)) {
    return fail({
      kind: "refused",
      phase: "init",
      message: `${session.label} returned an invalid completion address.`,
    });
  }
  return {
    ok: true,
    value: {
      upload: {
        url: upload.url,
        method: typeof upload.method === "string" ? upload.method : "PUT",
        headers:
          upload.headers && typeof upload.headers === "object"
            ? (upload.headers as Record<string, string>)
            : {},
      },
      completeUrl,
    },
  };
}

async function runUpload(
  session: LaunchSession,
  file: Blob,
  target: UploadTarget,
  onProgress: Progress,
  deps: SendDeps,
): Promise<Step<null>> {
  const allowed = deps.allowedUploadOrigins ?? integrationEnv.allowedUploadOrigins;
  if (!isOriginAllowed(target.url, allowed)) {
    return fail({
      kind: "upload-origin-not-allowed",
      phase: "upload",
      message: `${session.label} asked the editor to upload to an address that is not allowed.`,
    });
  }
  onProgress({ phase: "upload", fraction: 0 });
  try {
    const { status } = await uploadWithProgress(
      target.url,
      target.method,
      target.headers,
      file,
      (fraction) => onProgress({ phase: "upload", fraction }),
      deps.xhrFactory,
      deps.signal,
    );
    if (status < 200 || status >= 300) {
      return fail({
        kind: "network",
        phase: "upload",
        message: `Upload failed (${status})`,
        status,
      });
    }
  } catch {
    return fail({
      kind: "network",
      phase: "upload",
      message: "Upload failed (network)",
    });
  }
  return { ok: true, value: null };
}

async function runComplete(
  session: LaunchSession,
  meta: SendMeta,
  completeUrl: string,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
): Promise<Step<{ url?: string; message?: string }>> {
  const step = await postJson(session, fetchFn, "complete", completeUrl, {
    v: 1,
    filename: meta.filename,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
  }, signal);
  if (!step.ok) return step;
  const { url, message } = step.value;
  return {
    ok: true,
    value: {
      url: typeof url === "string" ? url : undefined,
      message: typeof message === "string" ? message : undefined,
    },
  };
}

export async function sendExport(
  session: LaunchSession,
  file: Blob,
  meta: SendMeta,
  onProgress: Progress,
  deps: SendDeps = {},
): Promise<SendResult> {
  const fetchFn: FetchLike = deps.fetchFn ?? ((i, init) => fetch(i, init));

  onProgress({ phase: "init", fraction: 0 });
  const init = await runInit(session, meta, fetchFn, deps.signal);
  if (!init.ok) return { ok: false, ...init.failure };

  const upload = await runUpload(session, file, init.value.upload, onProgress, deps);
  if (!upload.ok) return { ok: false, ...upload.failure };

  onProgress({ phase: "complete", fraction: 1 });
  if (deps.signal?.aborted) {
    return { ok: false, kind: "network", phase: "upload", message: "Upload failed (network)" };
  }
  const done = await runComplete(session, meta, init.value.completeUrl, fetchFn, deps.signal);
  if (!done.ok) return { ok: false, ...done.failure };
  return { ok: true, ...done.value };
}

/** XHR PUT of a Blob with upload progress. Rejects only on network error/timeout/abort. */
export function uploadWithProgress(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (fraction: number) => void,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
  signal?: AbortSignal,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Upload failed (network)"));
      return;
    }
    const xhr = xhrFactory();
    const onAbortSignal = () => xhr.abort();
    const settle = () => signal?.removeEventListener("abort", onAbortSignal);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      settle();
      resolve({ status: xhr.status });
    };
    const failed = () => {
      settle();
      reject(new Error("Upload failed (network)"));
    };
    xhr.onerror = failed;
    xhr.ontimeout = failed;
    // onabort fires for xhr.abort() from the caller's signal: maps to network.
    xhr.onabort = failed;
    signal?.addEventListener("abort", onAbortSignal, { once: true });
    xhr.open(method, url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.send(body);
  });
}
