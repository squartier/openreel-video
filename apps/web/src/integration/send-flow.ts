import { mimeForExt, type ExportFileHandler } from "../services/export-runner";
import { toast } from "../stores/notification-store";
import type { LaunchSession } from "./launch-session";
import { useLaunchSessionStore } from "./launch-session-store";
import { sendExport, type SendDeps, type SendMeta } from "./sender";
import { useSendStore, type SendState } from "./send-store";

const MB = 1024 * 1024;

/** Bytes as megabytes with one decimal, e.g. 52428800 → "50.0". */
export function formatMb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

/** The hard size refusal: never upload a file the calling app has said it will not accept. */
export function checkSendSize(
  session: LaunchSession,
  sizeBytes: number,
): { ok: true } | { ok: false; message: string } {
  if (session.maxBytes === undefined || sizeBytes <= session.maxBytes) return { ok: true };
  return {
    ok: false,
    message: `This export is ${formatMb(sizeBytes)} MB; ${session.label} accepts at most ${formatMb(session.maxBytes)} MB. Download it instead.`,
  };
}

/**
 * Drive useSendStore through sending → sent | failed. Never rejects: any
 * unexpected throw becomes a `failed` state so the kept file stays downloadable.
 * Calling it again (Retry) restarts from init with the same arguments.
 */
/** Bumped by every startSend; a send whose generation is no longer current never writes (R7a). */
let sendGeneration = 0;

export async function startSend(
  session: LaunchSession,
  file: Blob,
  filename: string,
  meta: SendMeta,
  deps?: SendDeps,
): Promise<void> {
  const generation = ++sendGeneration;
  const set = (s: SendState) => {
    if (generation === sendGeneration) useSendStore.getState().set(s);
  };
  set({ status: "sending", phase: "init", fraction: 0, file, filename, meta });
  try {
    const result = await sendExport(
      session,
      file,
      meta,
      ({ phase, fraction }) => set({ status: "sending", phase, fraction, file, filename, meta }),
      deps,
    );
    if (result.ok) {
      set({ status: "sent", url: result.url, message: result.message, file, filename });
    } else {
      const { ok: _ok, ...failure } = result;
      set({ status: "failed", failure, file, filename, meta });
    }
  } catch (error) {
    set({
      status: "failed",
      failure: {
        kind: "network",
        phase: "init",
        message: error instanceof Error && error.message ? error.message : `Could not send to ${session.label}`,
      },
      file,
      filename,
      meta,
    });
  }
}

const REVOKE_AFTER_MS = 60_000;

/** Anchor download of the kept file (local copy of export-runner's triggerAnchorDownload). */
export function downloadKeptFile(file: Blob, filename: string): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to start retaining large downloads before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

interface SendExportSettings {
  width?: number;
  height?: number;
  range?: { startTime: number; endTime: number };
}

interface SendProjectInfo {
  settings?: { width?: number; height?: number };
  timeline?: { duration?: number };
}

/**
 * The showSavePicker options for "send" delivery. The sink calls `onFile` once
 * the export is written; it never downloads in this mode. `onFile` never throws
 * and never returns a promise (ruling R5): anything that goes wrong becomes a
 * `failed` send state, which keeps the file downloadable from the result dialog.
 */
export function sendDeliveryOptions(
  ext: string,
  settings: SendExportSettings,
  project: SendProjectInfo,
): { delivery: "send"; onFile: ExportFileHandler } {
  const onFile: ExportFileHandler = (file, filename) => {
    const meta: SendMeta = {
      filename,
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      durationSec: 0,
      width: 0,
      height: 0,
    };
    try {
      meta.mimeType = mimeForExt(ext);
      meta.sizeBytes = file.size;
      meta.durationSec = settings.range
        ? settings.range.endTime - settings.range.startTime
        : project.timeline?.duration ?? 0;
      meta.width = settings.width ?? project.settings?.width ?? 0;
      meta.height = settings.height ?? project.settings?.height ?? 0;

      const session = useLaunchSessionStore.getState().session;
      if (!session) {
        // The session vanished mid-export: never lose the file.
        downloadKeptFile(file, filename);
        toast.info("Session ended", "The video was downloaded instead of sent.");
        return;
      }
      const size = checkSendSize(session, file.size);
      if (!size.ok) {
        toast.error("Too large to send", size.message);
        downloadKeptFile(file, filename);
        return;
      }
      void startSend(session, file, filename, meta);
    } catch (error) {
      useSendStore.getState().set({
        status: "failed",
        failure: {
          kind: "network",
          phase: "init",
          message: error instanceof Error && error.message ? error.message : "Could not start the upload",
        },
        file,
        filename,
        meta,
      });
    }
  };
  return { delivery: "send", onFile };
}
