import "../test/install-local-storage-mock";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useProjectRecovery", () => ({
  useProjectRecovery: () => ({
    isChecking: false, showDialog: false, availableSaves: [],
    recover: vi.fn(async () => false), dismiss: vi.fn(), clearAll: vi.fn(),
  }),
}));
vi.mock("../hooks/useKieAIPoller", () => ({ useKieAIPoller: () => undefined }));
vi.mock("../components/MobileBlocker", () => ({ MobileBlocker: () => null }));
vi.mock("../components/Toast", () => ({ ToastContainer: () => null }));
vi.mock("../components/editor/EditorInterface", () => ({ EditorInterface: () => <p>Editor</p> }));
vi.mock("../pages/SharePage", () => ({ SharePage: () => <p>Shared video</p> }));

const session = {
  v: 1 as const,
  app: "nremote-builder",
  label: "N-Remote Builder",
  returnUrl: "https://buildnow.n-remote.com/api/video-editor/deliver/init",
  token: "t",
};

async function loadFreshApp() {
  vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "");
  vi.stubEnv("DEV", false);
  vi.resetModules();
  const [{ default: App }, { useProjectStore }, { useUIStore }, { createEmptyProject }, { useLaunchSessionStore }] =
    await Promise.all([
      import("../App"),
      import("../stores/project-store"),
      import("../stores/ui-store"),
      import("../stores/project/project-helpers"),
      import("./launch-session-store"),
    ]);
  useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Unopened placeholder") });
  useUIStore.setState({ skipWelcomeScreen: false, activeModal: null });
  return { App, useLaunchSessionStore };
}

describe("LaunchBanner on arrival (welcome route)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    window.location.hash = "";
  });

  it("shows Editing for <label> above the welcome screen", async () => {
    const { App, useLaunchSessionStore } = await loadFreshApp();
    useLaunchSessionStore.getState().setSession(session);
    window.location.hash = "#/";
    render(<App />);
    // The welcome screen is present...
    await waitFor(() => expect(screen.getAllByText("NR Video").length).toBeGreaterThan(0));
    // ...and the banner is visible with it, not hidden inside the editor.
    expect(screen.getByRole("status")).toHaveTextContent("Editing for N-Remote Builder");
    useLaunchSessionStore.getState().clear();
  });

  it("shows the refusal alert above the welcome screen", async () => {
    const { App, useLaunchSessionStore } = await loadFreshApp();
    useLaunchSessionStore.getState().setRefusal("expired");
    window.location.hash = "#/";
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("NR Video").length).toBeGreaterThan(0));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not start the session/i);
    useLaunchSessionStore.getState().clear();
  });
});
