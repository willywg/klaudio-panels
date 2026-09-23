/**
 * One data path for every PTY xterm (agent tabs, the shell panel, embedded
 * editors). Decoding `pty:data` payloads and the flow-control accounting live
 * here so the three contexts cannot drift.
 *
 * xterm.js parses `term.write` on a timer. Once 50 MB is queued
 * (`DISCARD_WATERMARK`) it throws on every further write and drops the bytes.
 * We count bytes that have been handed to an xterm and not yet parsed, and
 * ask Rust to pause that PTY's reader above {@link PTY_HIGH_WATER}. The
 * reader stops calling `read`, the kernel PTY buffer fills, and the child
 * blocks in its next write — the agent waits instead of the webview drowning.
 * Below {@link PTY_LOW_WATER} we resume. Bytes that no handler wrote into an
 * xterm are not counted: a payload that arrives before the view subscribes is
 * dropped, same as before, and must not pause a PTY nobody is rendering.
 */

/** 1.5 MB pending. A full-screen TUI redraw is tens of KB, so this is a few
 *  dozen redraws of slack — a short stall does not pause the agent — and it
 *  sits far under xterm's 50 MB discard point. */
export const PTY_HIGH_WATER = 1_500_000;

/** 256 KB. Resume only after a real drain, so the gate does not flap on
 *  every chunk around the high watermark. */
export const PTY_LOW_WATER = 256 * 1024;

export type PtyWritable = {
  write(data: string | Uint8Array, callback?: () => void): void;
};

type FlowOp = "pause" | "resume";

type Flow = {
  pending: number;
  paused: boolean;
  disposed: boolean;
  /** Pause/resume commands not yet started. Drained in order so a resume
   *  cannot overtake the pause that caused it when the IPC is async. */
  queue: FlowOp[];
  pumping: boolean;
};

export type PtyFlow = {
  write(ptyId: string, term: PtyWritable, data: string | Uint8Array): void;
  release(ptyId: string): void;
  pending(ptyId: string): number;
};

export function createPtyFlow(opts: {
  pause: (ptyId: string) => void | Promise<void>;
  resume: (ptyId: string) => void | Promise<void>;
  highWater?: number;
  lowWater?: number;
}): PtyFlow {
  const highWater = opts.highWater ?? PTY_HIGH_WATER;
  const lowWater = opts.lowWater ?? PTY_LOW_WATER;
  if (lowWater >= highWater) {
    throw new Error("pty flow: low watermark must be below the high watermark");
  }
  const flows = new Map<string, Flow>();

  function flowFor(ptyId: string): Flow {
    let flow = flows.get(ptyId);
    if (!flow) {
      flow = { pending: 0, paused: false, disposed: false, queue: [], pumping: false };
      flows.set(ptyId, flow);
    }
    return flow;
  }

  function enqueue(ptyId: string, flow: Flow, op: FlowOp): void {
    flow.queue.push(op);
    pump(ptyId, flow);
  }

  function pump(ptyId: string, flow: Flow): void {
    if (flow.pumping) return;
    flow.pumping = true;
    const step = (): void => {
      const op = flow.queue.shift();
      if (!op) {
        flow.pumping = false;
        return;
      }
      let result: void | Promise<void>;
      try {
        result = op === "pause" ? opts.pause(ptyId) : opts.resume(ptyId);
      } catch {
        result = undefined;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).then(step, step);
        return;
      }
      step();
    };
    step();
  }

  function sync(ptyId: string, flow: Flow): void {
    if (flow.disposed) return;
    if (!flow.paused && flow.pending >= highWater) {
      flow.paused = true;
      enqueue(ptyId, flow, "pause");
    } else if (flow.paused && flow.pending < lowWater) {
      flow.paused = false;
      enqueue(ptyId, flow, "resume");
    }
  }

  return {
    write(ptyId, term, data) {
      const flow = flowFor(ptyId);
      if (flow.disposed) return;
      const len = typeof data === "string" ? data.length : data.byteLength;
      flow.pending += len;
      sync(ptyId, flow);
      try {
        term.write(data, () => {
          if (flow.disposed) return;
          flow.pending = Math.max(0, flow.pending - len);
          sync(ptyId, flow);
        });
      } catch {
        // An xterm throw (historically "write data discarded") must not
        // become a window.error per chunk. Roll the bytes back so a failed
        // write cannot pin the PTY in the paused state.
        if (!flow.disposed) {
          flow.pending = Math.max(0, flow.pending - len);
          sync(ptyId, flow);
        }
      }
    },
    release(ptyId) {
      const flow = flows.get(ptyId);
      if (!flow || flow.disposed) return;
      flow.disposed = true;
      flow.pending = 0;
      const wasPaused = flow.paused;
      flow.paused = false;
      // Drop anything still queued: the session is going away, and a pause
      // that has not been sent yet must not land after the resume below.
      flow.queue.length = 0;
      if (wasPaused) enqueue(ptyId, flow, "resume");
      flows.delete(ptyId);
    },
    pending(ptyId) {
      return flows.get(ptyId)?.pending ?? 0;
    },
  };
}

const ptyFlow = createPtyFlow({
  pause: (id) => invokeFlow("pty_pause", id),
  resume: (id) => invokeFlow("pty_resume", id),
});

function invokeFlow(cmd: "pty_pause" | "pty_resume", id: string): Promise<void> {
  // Imported lazily so unit tests of `createPtyFlow` never load the Tauri
  // runtime. A failed IPC is ignored: `pty_kill` also wakes the reader, so
  // a resume that races a close still cannot leave it parked.
  return import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke(cmd, { id }))
    .then(() => undefined)
    .catch(() => undefined);
}

/** Hand bytes to an xterm and account them against this PTY's watermark. */
export function writePtyChunk(
  ptyId: string,
  term: PtyWritable,
  data: string | Uint8Array,
): void {
  ptyFlow.write(ptyId, term, data);
}

/** Forget the watermark state. If the reader was paused, resume it so a
 *  closed or exited PTY cannot stay blocked. Safe to call twice. */
export function releasePtyFlow(ptyId: string): void {
  ptyFlow.release(ptyId);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Decode one `pty:data` payload and fan it out. An empty handler set is the
 *  "nobody is writing this into an xterm" case: the bytes are dropped and
 *  nothing is counted toward the watermark. */
export function deliverPtyPayload(
  b64: string,
  handlers: Set<(bytes: Uint8Array) => void> | undefined,
): void {
  if (!handlers || handlers.size === 0) return;
  const bytes = base64ToBytes(b64);
  for (const handler of handlers) handler(bytes);
}
