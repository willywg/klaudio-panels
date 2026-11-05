import { describe, expect, test } from "bun:test";
import { buildDropPayload } from "./os-drop";

describe("shell drop quoting", () => {
  test("PowerShell keeps variables, substitutions, and apostrophes literal", () => {
    const path = "C:\\external\\$HOME $(Write-Output changed) O'Brien.txt";
    expect(buildDropPayload([path], "C:\\project", "shell", "Win32")).toBe(
      "'C:\\external\\$HOME $(Write-Output changed) O''Brien.txt' ",
    );
  });

  test.each(["Linux x86_64", "MacIntel"])("%s retains POSIX quoting", (platform) => {
    expect(buildDropPayload(["/tmp/$HOME/O'Brien.txt"], "/project", "shell", platform)).toBe(
      "'/tmp/$HOME/O'\\''Brien.txt' ",
    );
  });

  test("ordinary shell paths and Claude project references stay unchanged", () => {
    expect(buildDropPayload(["/tmp/file.txt"], "/project", "shell")).toBe("/tmp/file.txt ");
    expect(buildDropPayload(["C:\\project\\src\\file.ts"], "C:\\project")).toBe("@src/file.ts ");
    expect(buildDropPayload([], "/project")).toBeNull();
  });

  test("project prefix matching is case-insensitive on Windows and macOS, case-sensitive on Linux", () => {
    expect(buildDropPayload(["c:\\Project\\src\\file.ts"], "C:\\project", "claude", "Win32")).toBe(
      "@src/file.ts ",
    );
    expect(buildDropPayload(["/Users/Me/Project/src/file.ts"], "/Users/me/project", "claude", "MacIntel")).toBe(
      "@src/file.ts ",
    );
    expect(buildDropPayload(["/home/me/Project/src/file.ts"], "/home/me/project", "claude", "Linux x86_64")).toBe(
      "/home/me/Project/src/file.ts ",
    );
  });

  test.skipIf(process.platform !== "win32")("PowerShell receives a literal filename", () => {
    const path = "C:\\external\\$HOME $(Write-Output changed) O'Brien.txt";
    const payload = buildDropPayload([path], "C:\\project", "shell", "Win32");
    const result = Bun.spawnSync([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Write-Output ${payload}`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(path);
    expect(result.stderr.toString()).toBe("");
  });
});
