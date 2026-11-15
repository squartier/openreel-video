import { parseLaunchSession, stripLaunchParam } from "./launch-session";
import { integrationEnv, useLaunchSessionStore } from "./launch-session-store";

/**
 * Reads the `launch` param once at startup (before the hash router rewrites
 * the URL), stores the outcome for the tab and strips the param from the URL.
 */
export function captureLaunchSession(
  win: Pick<Window, "location" | "history"> = window,
  store = useLaunchSessionStore,
): void {
  const { search, pathname, hash } = win.location;
  const result = parseLaunchSession(search, {
    allowedReturnOrigins: integrationEnv.allowedReturnOrigins,
  });
  if (!result.ok && result.reason === "missing") return;

  const state = store.getState();
  state.clear();
  if (result.ok) state.setSession(result.session);
  else state.setRefusal(result.reason);

  win.history.replaceState(null, "", pathname + stripLaunchParam(search) + hash);
}
