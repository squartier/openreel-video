import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { SendFailure, SendMeta, SendPhase } from "./sender";

/**
 * The state of one "Send to <label>" hand-off. Every non-idle state keeps the
 * exported file so the user can always download it (and retry a failure).
 */
export type SendState =
  | { status: "idle" }
  | { status: "sending"; phase: SendPhase; fraction: number; file: Blob; filename: string; meta: SendMeta }
  | { status: "sent"; url?: string; message?: string; file: Blob; filename: string }
  | { status: "failed"; failure: SendFailure; file: Blob; filename: string; meta: SendMeta };

type SendStore = SendState & { set(s: SendState): void; reset(): void };

/** Plain zustand, deliberately not persisted: a Blob cannot survive a reload. */
export const useSendStore: UseBoundStore<StoreApi<SendStore>> = create<SendStore>()((set) => ({
  status: "idle",
  // `set` replaces the whole state (true = replace) so stale fields never leak between states.
  set: (s) => set((prev) => ({ ...s, set: prev.set, reset: prev.reset }) as SendStore, true),
  reset: () => set((prev) => ({ status: "idle", set: prev.set, reset: prev.reset }) as SendStore, true),
}));
