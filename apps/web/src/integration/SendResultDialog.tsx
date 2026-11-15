import {
  ToolcraftButton as Button,
  ToolcraftDialog as Dialog,
  ToolcraftDialogHeader as DialogHeader,
  ToolcraftProgressBar as ProgressBar,
} from "@openreel/ui";
import { safeBackUrl } from "./LaunchBanner";
import { useLaunchSessionStore } from "./launch-session-store";
import { downloadKeptFile, startSend } from "./send-flow";
import { useSendStore, type SendState } from "./send-store";

function progressText(state: Extract<SendState, { status: "sending" }>): string {
  if (state.phase === "init") return "Preparing the upload…";
  if (state.phase === "complete") return "Finishing…";
  return `Uploading… ${Math.round(state.fraction * 100)}%`;
}

/**
 * Progress / success / failure of a "Send to <label>" hand-off. The kept file
 * is downloadable in every state. Close only resets the send store; it never
 * cancels the export runner (that would delete a file an upload may still read).
 */
export function SendResultDialog() {
  const state = useSendStore();
  const session = useLaunchSessionStore((s) => s.session);

  if (state.status === "idle") return null;

  const label = session?.label ?? "the calling app";
  const close = () => useSendStore.getState().reset();
  const download = () => downloadKeptFile(state.file, state.filename);

  const title =
    state.status === "sending"
      ? `Sending to ${label}`
      : state.status === "sent"
        ? `Sent to ${label}`
        : `Could not send to ${label}`;

  const back = state.status === "sent" ? safeBackUrl(session?.backUrl) : null;
  const canRetry = state.status === "failed" && state.failure.kind !== "expired" && !!session;

  return (
    <Dialog isOpen onOpenChange={(open) => !open && close()} width={440} purpose="status">
      <DialogHeader title={title} subtitle={state.filename} />
      <div className="space-y-3 px-5 py-4 text-[13px] text-fg">
        {state.status === "sending" && (
          <>
            <ProgressBar
              label="Send progress"
              isLabelHidden
              value={state.phase === "upload" ? Math.round(state.fraction * 100) : state.phase === "complete" ? 100 : 0}
            />
            <p className="text-[12px] text-fg-muted">{progressText(state)}</p>
          </>
        )}
        {state.status === "sent" && <p>{state.message ?? `The video was sent to ${label}.`}</p>}
        {state.status === "failed" && (
          <p role="alert" className="text-status-warning">
            {state.failure.kind === "expired"
              ? `Your session for ${label} has expired — download the file and upload it there.`
              : state.failure.message}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button label="Close" variant="ghost" onClick={close} />
        <Button label="Download" variant="secondary" onClick={download} />
        {canRetry && session && (
          <Button
            label="Retry"
            variant="primary"
            onClick={() => void startSend(session, state.file, state.filename, state.meta)}
          />
        )}
        {back && (
          <a
            href={back}
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent/90"
          >
            Back to {label}
          </a>
        )}
      </div>
    </Dialog>
  );
}
