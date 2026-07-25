import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTerminal, type TerminalTab } from "@/context/terminal";
import {
  getPrefs,
  setPrefs,
  type StatusBarPrefs,
  type StatusBarPrefsPatch,
} from "@/lib/status-bar-prefs";

// ---------------------------------------------------------------------
// Wire types — mirror `src-tauri/src/usage_snapshot.rs` and
// `src-tauri/src/statusline_snapshot.rs` exactly. Neither Rust struct
// applies a serde rename rule (plain `#[derive(Serialize, Deserialize)]`),
// so the JSON keys on the wire are the literal snake_case field names —
// NOT camelCase. Only the `invoke()` *argument* names get Tauri's
// automatic snake_case -> camelCase conversion; response bodies and event
// payloads are serialized as-is.
// ---------------------------------------------------------------------

export type ModelInfo = {
  id: string;
  display_name: string;
};

export type ContextUsage = {
  used_percentage: number | null;
  remaining_percentage: number | null;
};

export type RateWindow = {
  used_percentage: number;
  /** Unix epoch SECONDS (not ms) — see usage_snapshot::RateWindow. */
  resets_at: number;
};

export type RateLimitWindows = {
  five_hour: RateWindow | null;
  seven_day: RateWindow | null;
};

/** Payload of the `usage:snapshot` Tauri event, and the `tab` field of
 *  `read_status_snapshot`'s response — both are
 *  `usage_snapshot::UsageSnapshot`. */
export type UsageSnapshot = {
  provider_id: string;
  tab_id: string;
  session_id: string | null;
  /** Klaudio-generated wall-clock ms epoch at snapshot-write time. */
  observed_at: number;
  model: ModelInfo | null;
  context: ContextUsage | null;
  rate_limits: RateLimitWindows | null;
};

/** `profile_rate_limits` field of `read_status_snapshot`'s response —
 *  mirrors `statusline_snapshot::ProfileRateLimits`. */
export type ProfileRateLimitRecord = {
  rate_limits: RateLimitWindows;
  observed_at: number;
};

/** Response shape of the `read_status_snapshot` Tauri command — mirrors
 *  `statusline_snapshot::TabStatusView`. */
export type ReadStatusSnapshotResponse = {
  tab: UsageSnapshot | null;
  profile_rate_limits: ProfileRateLimitRecord | null;
};

// ---------------------------------------------------------------------
// Monotonic update rules — pure, exported for unit testing without a
// live Solid runtime. Both the push channel (`usage:snapshot`) and the
// pull channel (`read_status_snapshot`) funnel through these so a stale
// pulled read arriving after a fresher live event can never regress the
// display.
// ---------------------------------------------------------------------

/** True when `incoming` should replace `current` in the tab-scoped
 *  store: no prior value yet, or `incoming.observed_at` is strictly
 *  newer. A tie (equal `observed_at`) is intentionally NOT applied. */
export function shouldApplyTabSnapshot(
  incoming: UsageSnapshot,
  current: UsageSnapshot | undefined,
): boolean {
  if (!current) return true;
  return incoming.observed_at > current.observed_at;
}

/** True when an incoming rate-limit observation should replace `current`
 *  in the profile-scoped store. Mirrors
 *  `statusline_snapshot::freshest_rate_limits`'s merge policy exactly: a
 *  snapshot that carries no `rate_limits` at all has nothing to
 *  contribute to the profile-level record and never participates in the
 *  comparison, no matter how fresh its `observed_at` is — it must never
 *  overwrite, or be compared for staleness against, an existing record. */
export function shouldApplyProfileRateLimits(
  incomingRateLimits: RateLimitWindows | null | undefined,
  incomingObservedAt: number,
  current: ProfileRateLimitRecord | undefined,
): boolean {
  if (!incomingRateLimits) return false;
  if (!current) return true;
  return incomingObservedAt > current.observed_at;
}

// ---------------------------------------------------------------------
// tabId -> profileId lookup. The live `TerminalTab` list is the ONLY
// source of truth for this mapping — never a hash, never a round-trip to
// the backend (the `usage:snapshot` payload deliberately carries only
// `tab_id`, no wrapper envelope with a `profile_id`).
// ---------------------------------------------------------------------

/** Looks up the profileId owning `tabId` from the live tab list.
 *  `undefined` when the tab has already been closed — callers must treat
 *  that as a silent no-op, not an error: there's no live consumer left
 *  for a closed tab's data, and the profile-level record for any other
 *  tab on that profile is unaffected. */
export function resolveProfileIdForTab(
  tabs: readonly TerminalTab[],
  tabId: string,
): string | undefined {
  return tabs.find((t) => t.id === tabId)?.profileId;
}

// ---------------------------------------------------------------------
// Availability derivation — pure, independently-testable. See the task
// spec: "waiting" has no elapsed-time timeout (a managed-policy block or
// `disableAllHooks` is indistinguishable in principle from "just hasn't
// ticked yet"), and "unavailable" is legitimate in exactly two cases,
// never inferred from elapsed time.
// ---------------------------------------------------------------------

export type Availability = "waiting" | "available" | "unavailable";

/** Availability for the combined model+context status-bar section (a
 *  single `sections.model` prefs toggle covers both — see
 *  `lib/status-bar-prefs.ts`, there is no separate context toggle).
 *
 *  - `overlayInstalled === false` (while the feature was actually
 *    requested by the caller) means the backend is on record as having
 *    failed to prepare the bridge — nothing will ever arrive for this
 *    tab, so every widget is "unavailable", model/context included.
 *  - No snapshot yet is "waiting" — FOREVER, regardless of how long
 *    it's been. Do not add a timeout here.
 *  - A snapshot existing with neither `model` nor `context` populated
 *    isn't one of the two defined "unavailable" causes, so it stays
 *    "waiting" rather than flipping to "unavailable". */
export function modelContextAvailability(
  overlayInstalled: boolean,
  snapshot: UsageSnapshot | undefined,
): Availability {
  if (!overlayInstalled) return "unavailable";
  if (!snapshot) return "waiting";
  return snapshot.model !== null || snapshot.context !== null
    ? "available"
    : "waiting";
}

/** Availability for the rate-limit widgets (5h + weekly).
 *
 *  - `overlayInstalled === false` (while requested): same "bridge never
 *    ran" case as `modelContextAvailability` — "unavailable".
 *  - No snapshot yet: "waiting", no timeout, same as above.
 *  - A valid snapshot exists but `rate_limits` is `null`: "unavailable"
 *    — Claude Code itself omitted rate-limit data (near-certainly an
 *    API-key-billed session, where 5h/weekly windows are a Pro/Max-only
 *    concept). This is specific to the rate-limit widgets — it says
 *    nothing about `modelContextAvailability`, which stays "available"
 *    from that same snapshot regardless. */
export function rateLimitAvailability(
  overlayInstalled: boolean,
  snapshot: UsageSnapshot | undefined,
): Availability {
  if (!overlayInstalled) return "unavailable";
  if (!snapshot) return "waiting";
  return snapshot.rate_limits !== null ? "available" : "unavailable";
}

// ---------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------

type TabStatusStore = Record<string, UsageSnapshot>;
type ProfileRateLimitStore = Record<string, ProfileRateLimitRecord>;

function makeStatusBarContext() {
  const term = useTerminal();

  const [tabStatus, setTabStatus] = createStore<TabStatusStore>({});
  const [profileRateLimits, setProfileRateLimits] =
    createStore<ProfileRateLimitStore>({});

  // "Has this device ever used more than one profile" — grows only,
  // never shrinks when a tab closes. A later UI piece needs this to
  // decide whether to show a profile-alias prefix at all.
  const [knownProfileIdSet, setKnownProfileIdSet] = createSignal<
    ReadonlySet<string>
  >(new Set());

  createEffect(() => {
    // Reads term.store.tabs reactively — reruns whenever the tab list
    // (or any tab's profileId) changes, adding any newly-seen profileId.
    const seen = term.store.tabs.map((t) => t.profileId);
    setKnownProfileIdSet((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of seen) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  });

  function applyTabSnapshot(snapshot: UsageSnapshot) {
    const current = tabStatus[snapshot.tab_id];
    if (!shouldApplyTabSnapshot(snapshot, current)) return;
    setTabStatus(snapshot.tab_id, snapshot);
  }

  function applyProfileRateLimits(
    profileId: string,
    rateLimits: RateLimitWindows | null | undefined,
    observedAt: number,
  ) {
    const current = profileRateLimits[profileId];
    if (!shouldApplyProfileRateLimits(rateLimits, observedAt, current)) return;
    // Non-null asserted: shouldApplyProfileRateLimits already returned
    // false above for a null/undefined rateLimits.
    setProfileRateLimits(profileId, {
      rate_limits: rateLimits!,
      observed_at: observedAt,
    });
  }

  /** Live `usage:snapshot` handler. The payload carries only `tab_id` —
   *  the profileId is resolved by looking up the tab in the terminal
   *  store, never by hashing or any other means. */
  function handleUsageSnapshot(snapshot: UsageSnapshot) {
    applyTabSnapshot(snapshot);
    const profileId = resolveProfileIdForTab(term.store.tabs, snapshot.tab_id);
    if (!profileId) return; // tab already closed — no live consumer, no-op.
    applyProfileRateLimits(profileId, snapshot.rate_limits, snapshot.observed_at);
  }

  /** One-shot pull for a tab's own snapshot + its profile's freshest
   *  rate-limit window. Purely a catch-up mechanism for "tab just became
   *  active / was just created, before the bridge has ticked yet" — no
   *  polling loop, the live event is the primary channel. */
  async function ensureTabStatus(
    tabId: string,
    profileId: string,
  ): Promise<void> {
    try {
      const res = await invoke<ReadStatusSnapshotResponse>(
        "read_status_snapshot",
        { profileId, tabId },
      );
      if (res.tab) applyTabSnapshot(res.tab);
      if (res.profile_rate_limits) {
        applyProfileRateLimits(
          profileId,
          res.profile_rate_limits.rate_limits,
          res.profile_rate_limits.observed_at,
        );
      }
    } catch (err) {
      console.warn("read_status_snapshot failed", err);
    }
  }

  function tabSnapshot(tabId: string): UsageSnapshot | undefined {
    return tabStatus[tabId];
  }

  function profileRateLimitsFor(
    profileId: string,
  ): ProfileRateLimitRecord | undefined {
    return profileRateLimits[profileId];
  }

  function knownProfileIds(): string[] {
    return Array.from(knownProfileIdSet());
  }

  function knownProfileCount(): number {
    return knownProfileIdSet().size;
  }

  const [prefs, setPrefsSignal] = createSignal<StatusBarPrefs>(getPrefs());

  function updatePrefs(patch: StatusBarPrefsPatch) {
    setPrefs(patch);
    setPrefsSignal(getPrefs());
  }

  let unlistenUsage: UnlistenFn | null = null;

  onMount(async () => {
    try {
      unlistenUsage = await listen<UsageSnapshot>("usage:snapshot", (e) =>
        handleUsageSnapshot(e.payload),
      );
    } catch (err) {
      console.warn("status-bar: failed to subscribe to usage:snapshot", err);
    }
  });

  onCleanup(() => {
    unlistenUsage?.();
  });

  return {
    store: { tabStatus, profileRateLimits },
    tabSnapshot,
    profileRateLimitsFor,
    ensureTabStatus,
    knownProfileIds,
    knownProfileCount,
    prefs,
    updatePrefs,
  };
}

const Ctx = createContext<ReturnType<typeof makeStatusBarContext>>();

export function StatusBarProvider(props: ParentProps) {
  const ctx = makeStatusBarContext();
  return <Ctx.Provider value={ctx}>{props.children}</Ctx.Provider>;
}

export function useStatusBar() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStatusBar outside StatusBarProvider");
  return v;
}
