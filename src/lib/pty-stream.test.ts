import { describe, expect, test } from "bun:test";
import {
  bytesToBase64,
  createPtyFlow,
  deliverPtyPayload,
  type PtyWritable,
} from "@/lib/pty-stream";

function fakeTerm() {
  const callbacks: Array<() => void> = [];
  const term: PtyWritable = {
    write(_data, cb) {
      if (cb) callbacks.push(cb);
    },
  };
  return {
    term,
    ack(n = 1) {
      for (let i = 0; i < n; i++) callbacks.shift()?.();
    },
  };
}

function harness(highWater: number, lowWater: number) {
  const pauses: string[] = [];
  const resumes: string[] = [];
  const flow = createPtyFlow({
    highWater,
    lowWater,
    pause: (id) => {
      pauses.push(id);
    },
    resume: (id) => {
      resumes.push(id);
    },
  });
  return { flow, pauses, resumes, ...fakeTerm() };
}

describe("pty flow control", () => {
  test("crossing the high watermark pauses once, and draining below low resumes once", () => {
    const { flow, pauses, resumes, term, ack } = harness(100, 40);

    flow.write("pty", term, new Uint8Array(70));
    expect(pauses).toEqual([]);
    expect(flow.pending("pty")).toBe(70);

    flow.write("pty", term, new Uint8Array(40));
    flow.write("pty", term, new Uint8Array(10));
    expect(pauses).toEqual(["pty"]);
    expect(flow.pending("pty")).toBe(120);

    // 120 - 70 = 50, still above the low watermark.
    ack();
    expect(resumes).toEqual([]);
    // 50 - 40 = 10, which is below 40.
    ack();
    expect(resumes).toEqual(["pty"]);
    expect(flow.pending("pty")).toBe(10);

    ack();
    expect(resumes).toEqual(["pty"]);
    expect(flow.pending("pty")).toBe(0);
  });

  test("release clears accounting and resumes a paused reader exactly once", () => {
    const { flow, pauses, resumes, term } = harness(50, 10);
    flow.write("pty", term, new Uint8Array(80));
    expect(pauses).toEqual(["pty"]);

    flow.release("pty");
    expect(flow.pending("pty")).toBe(0);
    expect(resumes).toEqual(["pty"]);

    flow.release("pty");
    expect(resumes).toEqual(["pty"]);

    // A later write is a fresh gate, not a leftover pause.
    flow.write("pty", term, new Uint8Array(5));
    expect(flow.pending("pty")).toBe(5);
    expect(pauses).toEqual(["pty"]);
  });

  test("a write that throws does not escape and does not stick the pause", () => {
    const { flow, pauses, resumes } = harness(10, 4);
    const term: PtyWritable = {
      write() {
        throw new Error("write data discarded, use flow control to avoid losing data");
      },
    };
    expect(() => flow.write("pty", term, new Uint8Array(30))).not.toThrow();
    expect(flow.pending("pty")).toBe(0);
    // The pause was requested, then rolled back in the same turn.
    expect(pauses).toEqual(["pty"]);
    expect(resumes).toEqual(["pty"]);
  });

  test("bytes with no handler attached are not counted and do not pause", () => {
    const { flow, pauses, term } = harness(50, 10);
    const handlers = new Set<(bytes: Uint8Array) => void>();
    const payload = bytesToBase64(new Uint8Array(200));

    deliverPtyPayload(payload, handlers);
    expect(flow.pending("pty")).toBe(0);
    expect(pauses).toEqual([]);

    handlers.add((bytes) => flow.write("pty", term, bytes));
    deliverPtyPayload(payload, handlers);
    expect(flow.pending("pty")).toBe(200);
    expect(pauses).toEqual(["pty"]);
  });
});
