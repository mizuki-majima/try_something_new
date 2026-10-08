/**
 * React bindings for the app store (see appStore.ts for the sync model).
 *
 *   const { challenges, today, stamp } = useApp();
 *   const res = stamp(ch.id, day);            // optimistic; returns { ok } or { ok: false, message, fields }
 *   if (!res.ok) toast(res.message, { tone: "error" });
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Challenge, User } from "@thirty/shared";
import { useToast } from "../components/Toast";
import { createAppStore, type AppActions, type AppSnapshot, type AppStore, type SyncStatus, type Throttle } from "./appStore";

export type { AppActions, AppSnapshot, AppStore, StartChallengeInput, SyncStatus, Throttle } from "./appStore";
export type { ActionResult } from "./validation";

const StoreContext = createContext<AppStore | null>(null);

export function AppProvider({ children, store: injected }: { children: ReactNode; store?: AppStore }) {
  const [store] = useState(() => injected ?? createAppStore());
  const toast = useToast();
  useEffect(() => store.start(), [store]);
  useEffect(() => store.onNotice((n) => toast(n.message, { tone: n.kind === "error" ? "error" : "info" })), [store, toast]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("AppProvider is missing");
  return store;
}

function useSelect<T>(select: (s: AppSnapshot) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}

export type AppContextValue = AppSnapshot & AppActions;

/** Everything: state snapshot + actions. Re-renders on any store change. */
export function useApp(): AppContextValue {
  const store = useStore();
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return useMemo(() => ({ ...snap, ...store.actions }), [snap, store]);
}

/** Actions only (stable; does not re-render on state changes). */
export function useAppActions(): AppActions {
  return useStore().actions;
}

export function useUser(): User | null {
  return useSelect((s) => s.user);
}

export function useChallenges(): Challenge[] {
  return useSelect((s) => s.challenges);
}

export function useChallenge(id: string | undefined): Challenge | undefined {
  const list = useChallenges();
  return useMemo(() => (id ? list.find((c) => c.id === id) : undefined), [list, id]);
}

/** The server still shows this day note although a queued write here makes it private (#17, AppSnapshot.stillShown). */
export function useStillShown(challengeId: string, day: number): boolean {
  const key = `${challengeId}#${day}`;
  return useSelect((s) => s.stillShown.includes(key));
}

/** Today's YYYY-MM-DD in the user's time zone; re-renders after midnight. */
export function useToday(): string {
  return useSelect((s) => s.today);
}

export type SyncInfo = {
  status: SyncStatus;
  pending: number;
  online: boolean;
  hasSession: boolean;
  sessionInvalid: boolean;
  lastSyncError: string | null;
  /** Set while status is "waiting": when sending resumes and why. */
  throttle: Throttle | null;
};

export function useSync(): SyncInfo {
  const status = useSelect((s) => s.syncStatus);
  const pending = useSelect((s) => s.pending);
  const online = useSelect((s) => s.online);
  const hasSession = useSelect((s) => s.hasSession);
  const sessionInvalid = useSelect((s) => s.sessionInvalid);
  const lastSyncError = useSelect((s) => s.lastSyncError);
  const throttle = useSelect((s) => s.throttle);
  return useMemo(
    () => ({ status, pending, online, hasSession, sessionInvalid, lastSyncError, throttle }),
    [status, pending, online, hasSession, sessionInvalid, lastSyncError, throttle],
  );
}
