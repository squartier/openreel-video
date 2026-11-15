import { BRAND_NAME } from "./branding";
import { useLaunchSessionStore, type LaunchRefusal } from "./launch-session-store";

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

/** Plain words for each refusal code; the code itself is shown after them. */
export function refusalWords(code: LaunchRefusal): string {
  switch (code) {
    case "origin-not-allowed":
      return "the calling app is not allowed";
    case "expired":
      return "the link has expired";
    default:
      // malformed, invalid-fields, unsupported-version (and missing)
      return "the link is not valid";
  }
}

/**
 * Fixed to the top of the viewport so it shows above the welcome overlay
 * (`fixed inset-0 z-50`) as well as the editor; below MobileBlocker (z-[9999]).
 * App gives its content a matching top offset (h-8) while the banner renders.
 */
const BAR =
  "fixed top-0 inset-x-0 z-[60] h-8 flex items-center gap-3 px-3 text-xs border-b border-border bg-bg-3 text-fg-muted";

/** True when LaunchBanner renders something (App uses it for the top offset). */
export function useLaunchBannerVisible(): boolean {
  return useLaunchSessionStore((s) => s.session !== null || s.refusal !== null);
}

export function LaunchBanner() {
  const session = useLaunchSessionStore((s) => s.session);
  const refusal = useLaunchSessionStore((s) => s.refusal);
  const clear = useLaunchSessionStore((s) => s.clear);

  if (refusal) {
    const fullText = `${BRAND_NAME} could not start the session from this link: ${refusalWords(refusal)} (${refusal}). You can keep editing; Send is unavailable.`;
    return (
      <div role="alert" className={BAR}>
        <span className="flex-1 truncate" title={fullText}>
          {fullText}
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
  const fullText = `Editing for ${session.label}`;
  return (
    <div role="status" className={BAR}>
      <span className="flex-1 truncate text-fg" title={fullText}>
        {fullText}
      </span>
      {back && (
        <a href={back} className="shrink-0 text-accent hover:underline">
          Back to {session.label}
        </a>
      )}
    </div>
  );
}
