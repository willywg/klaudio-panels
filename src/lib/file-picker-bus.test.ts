import { describe, expect, test } from "bun:test";
import {
  answerFilePick,
  askWhichFile,
  pendingFilePick,
} from "@/lib/file-picker-bus";

describe("file-picker-bus", () => {
  test("resolves with the chosen candidate", async () => {
    const p = askWhichFile("app/main.py", [
      "core/app/main.py",
      "telegram/app/main.py",
    ]);
    expect(pendingFilePick()?.rel).toBe("app/main.py");
    answerFilePick("telegram/app/main.py");
    expect(await p).toBe("telegram/app/main.py");
    expect(pendingFilePick()).toBeNull();
  });

  test("resolves null when dismissed", async () => {
    const p = askWhichFile("x.py", ["a/x.py", "b/x.py"]);
    answerFilePick(null);
    expect(await p).toBeNull();
    expect(pendingFilePick()).toBeNull();
  });

  test("a second question cancels the first instead of stranding it", async () => {
    // Without this the first caller's promise never settles and its
    // continuation leaks — the click that opened it is simply lost.
    const first = askWhichFile("a.py", ["x/a.py", "y/a.py"]);
    const second = askWhichFile("b.py", ["x/b.py", "y/b.py"]);
    expect(await first).toBeNull();

    expect(pendingFilePick()?.rel).toBe("b.py");
    answerFilePick("x/b.py");
    expect(await second).toBe("x/b.py");
  });

  test("answering with nothing pending is a no-op", () => {
    expect(pendingFilePick()).toBeNull();
    expect(() => answerFilePick("whatever")).not.toThrow();
  });
});
