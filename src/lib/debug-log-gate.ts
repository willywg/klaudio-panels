/**
 * Pure limiter in front of `debugLog`. A hot-path exception used to be
 * forwarded once per occurrence — 194k `window.error`s in two minutes, each
 * with a stack, each an IPC write. Identical errors collapse to one full
 * line plus at most one summary per key per interval. Everything else is
 * counted. A global cap drops excess lines in a given second instead of
 * sending them.
 *
 * The clock is injected so tests don't sleep. `emit` is best-effort: a
 * throw inside it is swallowed, and nothing here returns a promise.
 */

export const ERROR_SUMMARY_INTERVAL_MS = 10_000;
export const MAX_LOG_LINES_PER_SECOND = 20;

export type DebugEmit = (tag: string, msg: string) => void;

export type ForwardedError = {
  tag: string;
  name: string;
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
};

type Slot = {
  tag: string;
  name: string;
  message: string;
  loc: string;
  windowStart: number;
  repeats: number;
};

export type DebugGate = {
  /** Any tagged line, subject to the global per-second cap. */
  record(tag: string, msg: string): void;
  /** Deduped window error / rejection. First sighting is logged whole. */
  recordError(error: ForwardedError): void;
  /** Emit a summary for every key whose interval has elapsed and that still
   *  has unreported repeats. */
  flush(): void;
};

export function createDebugGate(opts: {
  now: () => number;
  emit: DebugEmit;
  intervalMs?: number;
  maxPerSecond?: number;
}): DebugGate {
  const intervalMs = opts.intervalMs ?? ERROR_SUMMARY_INTERVAL_MS;
  const maxPerSecond = opts.maxPerSecond ?? MAX_LOG_LINES_PER_SECOND;
  const slots = new Map<string, Slot>();
  let second = Math.floor(opts.now() / 1000);
  let sentThisSecond = 0;
  let suppressed = 0;

  function safeEmit(tag: string, msg: string): void {
    try {
      opts.emit(tag, msg);
    } catch {
      // Logging is best-effort. A broken sink must not become another error.
    }
  }

  function rollSecond(): void {
    const nowSecond = Math.floor(opts.now() / 1000);
    if (nowSecond === second) return;
    const dropped = suppressed;
    second = nowSecond;
    sentThisSecond = 0;
    suppressed = 0;
    if (dropped > 0) {
      sentThisSecond += 1;
      safeEmit("log", `suppressed ${dropped} log line(s) in the previous second`);
    }
  }

  function emit(tag: string, msg: string): void {
    rollSecond();
    if (sentThisSecond >= maxPerSecond) {
      suppressed += 1;
      return;
    }
    sentThisSecond += 1;
    safeEmit(tag, msg);
  }

  function locOf(error: ForwardedError): string {
    if (!error.filename) return "(no loc)";
    return `${error.filename}:${error.lineno ?? 0}:${error.colno ?? 0}`;
  }

  function keyOf(error: ForwardedError): string {
    return `${error.name}\0${error.message}\0${locOf(error)}`;
  }

  function summary(slot: Slot): string {
    return `${slot.loc} — ${slot.name}: ${slot.message} — repeated ${slot.repeats} times in the last ${intervalMs / 1000}s`;
  }

  function emitSummary(slot: Slot): void {
    const line = summary(slot);
    slot.repeats = 0;
    slot.windowStart = opts.now();
    emit(slot.tag, line);
  }

  return {
    record(tag, msg) {
      emit(tag, msg);
    },
    recordError(error) {
      const key = keyOf(error);
      const existing = slots.get(key);
      if (!existing) {
        const slot: Slot = {
          tag: error.tag,
          name: error.name,
          message: error.message,
          loc: locOf(error),
          windowStart: opts.now(),
          repeats: 0,
        };
        slots.set(key, slot);
        const stack = error.stack ?? "(no stack)";
        emit(error.tag, `${slot.loc} — ${error.name}: ${error.message}\n${stack}`);
        return;
      }
      existing.repeats += 1;
      if (opts.now() - existing.windowStart >= intervalMs && existing.repeats > 0) {
        emitSummary(existing);
      }
    },
    flush() {
      const now = opts.now();
      for (const slot of slots.values()) {
        if (slot.repeats > 0 && now - slot.windowStart >= intervalMs) {
          emitSummary(slot);
        }
      }
    },
  };
}
