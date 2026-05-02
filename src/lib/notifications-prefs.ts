export type NotificationPrefs = {
  notifySessionComplete: boolean;
  notifyPermission: boolean;
  playSounds: boolean;
};

const KEY = "notificationPrefs";

const DEFAULTS: NotificationPrefs = {
  notifySessionComplete: true,
  notifyPermission: true,
  playSounds: true,
};

export function getPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      notifySessionComplete:
        parsed.notifySessionComplete ?? DEFAULTS.notifySessionComplete,
      notifyPermission: parsed.notifyPermission ?? DEFAULTS.notifyPermission,
      playSounds: parsed.playSounds ?? DEFAULTS.playSounds,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPrefs(patch: Partial<NotificationPrefs>): void {
  try {
    const next = { ...getPrefs(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // best-effort: storage may be denied in some webview configs.
  }
}
