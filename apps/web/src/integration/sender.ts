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
}

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

/** POST JSON with the session token and map every failure per the contract. */
async function postJson(
  session: LaunchSession,
  fetchFn: FetchLike,
  phase: "init" | "complete",
  url: string,
  body: unknown,
): Promise<Step<Record<string, unknown>>> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
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
    json = (await response.json()) as Record<string, unknown>;
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

async function runInit(
  session: LaunchSession,
  meta: SendMeta,
  fetchFn: FetchLike,
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
  });
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
): Promise<Step<{ url?: string; message?: string }>> {
  const step = await postJson(session, fetchFn, "complete", completeUrl, {
    v: 1,
    filename: meta.filename,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
  });
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
  const init = await runInit(session, meta, fetchFn);
  if (!init.ok) return { ok: false, ...init.failure };

  const upload = await runUpload(session, file, init.value.upload, onProgress, deps);
  if (!upload.ok) return { ok: false, ...upload.failure };

  onProgress({ phase: "complete", fraction: 1 });
  const done = await runComplete(session, meta, init.value.completeUrl, fetchFn);
  if (!done.ok) return { ok: false, ...done.failure };
  return { ok: true, ...done.value };
}

/** XHR PUT of a Blob with upload progress. Rejects only on network error/timeout. */
export function uploadWithProgress(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (fraction: number) => void,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => resolve({ status: xhr.status });
    xhr.onerror = () => reject(new Error("Upload failed (network)"));
    xhr.ontimeout = () => reject(new Error("Upload failed (network)"));
    xhr.open(method, url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.send(body);
  });
}
