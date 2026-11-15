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

// vitest runs with DEV=true (upstream's localhost cloud default), so the
// component tests stub a production build and import fresh module graphs.
async function loadFreshApp() {
  vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "");
  vi.stubEnv("DEV", false);
  vi.resetModules();
  const [{ default: App }, { WelcomeScreen }, { useProjectStore }, { useUIStore }, { createEmptyProject }] =
    await Promise.all([
      import("../App"),
      import("../components/welcome/WelcomeScreen"),
      import("../stores/project-store"),
      import("../stores/ui-store"),
      import("../stores/project/project-helpers"),
    ]);
  useProjectStore.setState({ hasOpenProject: false, project: createEmptyProject("Unopened placeholder") });
  useUIStore.setState({ skipWelcomeScreen: false, activeModal: null });
  return { App, WelcomeScreen };
}

describe("upstream cloud off", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    window.location.hash = "";
  });

  it("CLOUD_ENABLED is false when VITE_OPENREEL_CLOUD_URL is empty", async () => {
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "");
    vi.stubEnv("DEV", false);
    vi.resetModules();
    const mod = await import("@/config/api-endpoints");
    expect(mod.CLOUD_ENABLED).toBe(false);
    expect(mod.OPENREEL_CLOUD_URL).toBe("");
  });

  it("a whitespace-only VITE_OPENREEL_CLOUD_URL counts as unset (cloud off)", async () => {
    vi.stubEnv("VITE_OPENREEL_CLOUD_URL", "   ");
    vi.stubEnv("DEV", false);
    vi.resetModules();
    const mod = await import("@/config/api-endpoints");
    expect(mod.CLOUD_ENABLED).toBe(false);
    expect(mod.OPENREEL_CLOUD_URL).toBe("");
  });

  it("welcome screen shows the brand name and no Templates button when cloud is off", async () => {
    const { WelcomeScreen } = await loadFreshApp();
    render(<WelcomeScreen />);
    expect(screen.getByText("N-Remote Video")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /templates/i })).toBeNull();
  });

  it("#/share/<id> renders the welcome screen when cloud is off", async () => {
    const { App } = await loadFreshApp();
    window.location.hash = "#/share/abc";
    render(<App />);
    await waitFor(() => expect(screen.getByText("N-Remote Video")).toBeTruthy());
    expect(screen.queryByText("Shared video")).toBeNull();
  });

  it("no fetch is made to an openreel.video host when the welcome screen mounts with cloud off", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { WelcomeScreen } = await loadFreshApp();
    render(<WelcomeScreen />);
    await new Promise((r) => setTimeout(r, 0));
    const hits = spy.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      return url.includes("openreel.video");
    });
    expect(hits).toEqual([]);
  });
});
