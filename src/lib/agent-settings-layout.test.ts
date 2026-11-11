import { expect, test } from "bun:test";

// Structural guard: Bun has no browser layout engine. Rendered geometry still
// needs verification in the desktop webview at short and narrow viewport sizes.
const source = await Bun.file(
  new URL("../components/agent-settings-dialog.tsx", import.meta.url),
).text();
const panelClasses = source.match(/ref=\{panelRef\}\s+class="([^"]+)"/)?.[1].split(/\s+/) ?? [];

test("agent settings stays within the viewport and allows vertical scrolling", () => {
  expect(panelClasses).toContain("max-h-[calc(100dvh-32px)]");
  expect(panelClasses).toContain("overflow-y-auto");
});

test("agent settings retains its existing responsive width", () => {
  expect(panelClasses).toContain("w-[520px]");
  expect(panelClasses).toContain("max-w-[calc(100vw-32px)]");
});
