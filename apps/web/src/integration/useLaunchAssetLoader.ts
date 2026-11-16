// N-REMOTE INTEGRATION: pre-loads the caller's media (launch session `assets`) onto the timeline.
import { useEffect } from "react";
import { useProjectStore } from "../stores/project-store";
import { isOriginAllowed } from "./launch-session";
import { integrationEnv, useLaunchSessionStore } from "./launch-session-store";

const DONE_KEY = "nremote-launch-assets-loaded";

export function useLaunchAssetLoader(initialized: boolean): void {
  const session = useLaunchSessionStore((s) => s.session);

  useEffect(() => {
    const assets = session?.assets;
    if (!initialized || !assets?.length) return;
    // Once per launch token, so reloads in the same tab do not import twice.
    if (sessionStorage.getItem(DONE_KEY) === session.token) return;
    const { project } = useProjectStore.getState();
    if (project.timeline.tracks.some((t) => t.clips.length > 0)) return;
    sessionStorage.setItem(DONE_KEY, session.token);

    let cancelled = false;
    (async () => {
      for (const asset of assets) {
        if (cancelled) return;
        if (!isOriginAllowed(asset.url, integrationEnv.allowedUploadOrigins)) {
          console.warn("[launch] asset origin not allowed, skipped:", asset.name);
          continue;
        }
        try {
          const res = await fetch(asset.url, { mode: "cors", credentials: "omit" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const file = new File([blob], asset.name, { type: blob.type || "video/mp4" });
          const store = useProjectStore.getState();
          const before = new Set(store.project.mediaLibrary.items.map((i) => i.id));
          const result = await store.importMedia(file);
          if (!result.success) throw new Error("import failed");
          const added = useProjectStore.getState().project.mediaLibrary.items.find((i) => !before.has(i.id));
          if (added) await useProjectStore.getState().addClipToNewTrack(added.id, 0);
        } catch (e) {
          console.error("[launch] could not pre-load", asset.name, e);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [initialized, session]);
}
