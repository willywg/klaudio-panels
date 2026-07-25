export type StatusBarSections = {
  model: boolean;
  git: boolean;
  usage5h: boolean;
  usageWeekly: boolean;
};

export type StatusBarPrefs = {
  enabled: boolean;
  sections: StatusBarSections;
  usageIntegrationEnabled: boolean;
  showAsRemainingVsUsed: "used" | "remaining";
  resetDisplay: "countdown" | "timestamp";
  /** Keyed by profileId (e.g. "default", "custom:base64..."). Never derive
   *  or display the raw profileId itself in any UI — this map exists
   *  precisely so the UI can show a human name instead. */
  profileAliases: Record<string, string>;
};

const KEY = "statusBarPrefs";

const DEFAULTS: StatusBarPrefs = {
  enabled: true,
  sections: {
    model: true,
    git: true,
    usage5h: true,
    usageWeekly: true,
  },
  usageIntegrationEnabled: true,
  showAsRemainingVsUsed: "used",
  resetDisplay: "countdown",
  profileAliases: {},
};

function defaultSections(): StatusBarSections {
  return { ...DEFAULTS.sections };
}

function mergeSections(
  partial: Partial<StatusBarSections> | null | undefined,
): StatusBarSections {
  return {
    model: partial?.model ?? DEFAULTS.sections.model,
    git: partial?.git ?? DEFAULTS.sections.git,
    usage5h: partial?.usage5h ?? DEFAULTS.sections.usage5h,
    usageWeekly: partial?.usageWeekly ?? DEFAULTS.sections.usageWeekly,
  };
}

function mergeProfileAliases(
  partial: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!partial || typeof partial !== "object") return {};
  return { ...partial };
}

export function getPrefs(): StatusBarPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return { ...DEFAULTS, sections: defaultSections(), profileAliases: {} };
    }
    const parsed = JSON.parse(raw) as Partial<StatusBarPrefs>;
    return {
      enabled: parsed.enabled ?? DEFAULTS.enabled,
      sections: mergeSections(parsed.sections),
      usageIntegrationEnabled:
        parsed.usageIntegrationEnabled ?? DEFAULTS.usageIntegrationEnabled,
      showAsRemainingVsUsed:
        parsed.showAsRemainingVsUsed ?? DEFAULTS.showAsRemainingVsUsed,
      resetDisplay: parsed.resetDisplay ?? DEFAULTS.resetDisplay,
      profileAliases: mergeProfileAliases(parsed.profileAliases),
    };
  } catch {
    return { ...DEFAULTS, sections: defaultSections(), profileAliases: {} };
  }
}

/** Same as `Partial<StatusBarPrefs>` except `sections` accepts a partial
 *  object too (TS's built-in `Partial` is shallow, so `Partial<StatusBarPrefs>`
 *  alone would force callers to pass all four `sections` keys whenever they
 *  want to flip just one). `profileAliases` doesn't need the same treatment
 *  — `Record<string, string>` already permits any subset of keys. */
export type StatusBarPrefsPatch = Partial<Omit<StatusBarPrefs, "sections">> & {
  sections?: Partial<StatusBarSections>;
};

export function setPrefs(patch: StatusBarPrefsPatch): void {
  try {
    const current = getPrefs();
    const next: StatusBarPrefs = {
      ...current,
      ...patch,
      sections: mergeSections({ ...current.sections, ...patch.sections }),
      profileAliases: mergeProfileAliases({
        ...current.profileAliases,
        ...patch.profileAliases,
      }),
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // best-effort: storage may be denied in some webview configs.
  }
}
