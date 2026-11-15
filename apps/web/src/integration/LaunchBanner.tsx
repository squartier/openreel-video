import { useLaunchSessionStore } from "./launch-session-store";

/**
 * A backUrl can come from a crafted link, so only http(s) URLs are linkable.
 * Anything else (javascript:, data:, unparseable) yields null: no link.
 */
export function safeBackUrl(backUrl: string | undefined): string | null {
  if (!backUrl) return null;
  try {
    const url = new URL(backUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? backUrl : null;
  } catch {
    return null;
  }
}

const BAR =
  "h-8 flex items-center gap-3 px-3 text-xs border-b border-border shrink-0 bg-bg-3 text-fg-muted";

export function LaunchBanner() {
  const session = useLaunchSessionStore((s) => s.session);
  const refusal = useLaunchSessionStore((s) => s.refusal);
  const clear = useLaunchSessionStore((s) => s.clear);

  if (refusal) {
    return (
      <div role="alert" className={BAR}>
        <span className="flex-1 truncate">
          N-Remote Video could not start the session from this link ({refusal}). You can keep
          editing; Send is unavailable.
        </span>
        <button
          type="button"
          className="shrink-0 rounded px-2 py-0.5 text-fg hover:bg-bg-1"
          onClick={clear}
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (!session) return null;

  const back = safeBackUrl(session.backUrl);
  return (
    <div role="status" className={BAR}>
      <span className="flex-1 truncate text-fg">Editing for {session.label}</span>
      {back && (
        <a href={back} className="shrink-0 text-accent hover:underline">
          Back to {session.label}
        </a>
      )}
    </div>
  );
}
