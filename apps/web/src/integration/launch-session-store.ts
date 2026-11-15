import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  parseOriginList,
  type LaunchSession,
  type LaunchParseResult,
} from "./launch-session";

export type LaunchRefusal = Exclude<
  Extract<LaunchParseResult, { ok: false }>["reason"],
  never
>;

export interface LaunchSessionState {
  session: LaunchSession | null;
  /** Non-null when a launch param was present but refused. */
  refusal: LaunchRefusal | null;
  setSession(s: LaunchSession): void;
  setRefusal(r: NonNullable<LaunchSessionState["refusal"]>): void;
  clear(): void;
}

export const useLaunchSessionStore = create<LaunchSessionState>()(
  persist(
    (set) => ({
      session: null,
      refusal: null,
      setSession: (session) => set({ session, refusal: null }),
      setRefusal: (refusal) => set({ session: null, refusal }),
      clear: () => set({ session: null, refusal: null }),
    }),
    {
      name: "nremote-launch-session",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ session: s.session, refusal: s.refusal }),
    },
  ),
);

export interface IntegrationEnv {
  allowedReturnOrigins: string[];
  allowedUploadOrigins: string[];
}

function readEnv(): IntegrationEnv {
  return {
    allowedReturnOrigins: parseOriginList(
      import.meta.env.VITE_ALLOWED_RETURN_ORIGINS,
    ),
    allowedUploadOrigins: parseOriginList(
      import.meta.env.VITE_ALLOWED_UPLOAD_ORIGINS,
    ),
  };
}

/** Read once from import.meta.env; mutable so tests can reset it in place. */
export const integrationEnv: IntegrationEnv = readEnv();

export function resetIntegrationEnvForTests(
  overrides: Partial<IntegrationEnv> = {},
): void {
  Object.assign(integrationEnv, readEnv(), overrides);
}
