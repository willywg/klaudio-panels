import { describe, expect, test } from "bun:test";
import { createDebugGate, type ForwardedError } from "@/lib/debug-log-gate";

function clock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const sample = (over: Partial<ForwardedError> = {}): ForwardedError => ({
  tag: "window.error",
  name: "Error",
  message: "write data discarded, use flow control to avoid losing data",
  filename: "tauri://localhost/assets/index.js",
  lineno: 35,
  colno: 116667,
  stack: "Error: write data discarded\n    at write (index.js:35:116667)",
  ...over,
});

describe("debug log gate", () => {
  test("10_000 identical errors become one full entry plus one summary", () => {
    const t = clock();
    const lines: Array<{ tag: string; msg: string }> = [];
    const gate = createDebugGate({
      now: t.now,
      emit: (tag, msg) => lines.push({ tag, msg }),
    });

    for (let i = 0; i < 10_000; i++) gate.recordError(sample());

    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toContain("write data discarded");
    expect(lines[0].msg).toContain("at write");
    expect(lines[0].tag).toBe("window.error");

    t.advance(10_000);
    gate.flush();

    expect(lines).toHaveLength(2);
    expect(lines[1].msg).toContain("repeated 9999 times in the last 10s");
    expect(lines[1].msg).not.toContain("at write");
  });

  test("distinct keys are logged separately", () => {
    const t = clock();
    const lines: string[] = [];
    const gate = createDebugGate({
      now: t.now,
      emit: (_tag, msg) => lines.push(msg),
    });

    gate.recordError(sample());
    gate.recordError(sample({ message: "different failure", lineno: 9, colno: 1 }));
    gate.recordError(
      sample({ tag: "window.rejection", name: "Rejection", filename: undefined, message: "nope" }),
    );

    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("different failure");
    expect(lines[2]).toContain("(no loc) — Rejection: nope");
  });

  test("a global per-second cap counts the overflow instead of sending it", () => {
    const t = clock();
    const lines: string[] = [];
    const gate = createDebugGate({
      now: t.now,
      emit: (_tag, msg) => lines.push(msg),
      maxPerSecond: 20,
    });

    for (let i = 0; i < 100; i++) gate.record("pty", `line ${i}`);
    expect(lines).toHaveLength(20);

    t.advance(1000);
    gate.record("pty", "after");

    expect(lines).toHaveLength(22);
    expect(lines[20]).toContain("suppressed 80 log line(s) in the previous second");
    expect(lines[21]).toBe("after");
  });

  test("a throwing sink does not escape", () => {
    const gate = createDebugGate({
      now: () => 0,
      emit: () => {
        throw new Error("sink down");
      },
    });
    expect(() => gate.record("window.error", "boom")).not.toThrow();
    expect(() => gate.recordError(sample())).not.toThrow();
  });
});
