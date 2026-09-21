/** Structural minimum a tab has to satisfy to be torn down. Kept local rather
 *  than importing `TerminalTab` so this stays a pure module the tests can
 *  drive without the terminal context. */
export type ClosableTab = { id: string; projectPath: string };

export type TabRemoval<T extends ClosableTab> = {
  tabs: T[];
  activeTabId: string | null;
};

/** Removes every tab belonging to `projectPath` **in one step**.
 *
 *  The one-step part is the whole point, not an optimization. Closing a
 *  project used to walk its tabs and remove them one at a time, and the
 *  workspace-persistence effect (#98) tracks the tab store — so it fired
 *  *between* removals and wrote whatever was left. A project with two tabs
 *  was remembered as one, the last one to be removed (#105). The guard that
 *  was supposed to prevent this only ever covered the final step, from one
 *  tab to none; nothing covered the descent from N to one, which is where
 *  the workspace was actually lost.
 *
 *  Collapsing it to a single transition means an observer only ever sees N
 *  tabs or none — and "none" is already the case the persistence effect
 *  deliberately skips rather than records. That fixes the class rather than
 *  the instance: any future observer of the tab store inherits the same
 *  guarantee without knowing this bug existed.
 *
 *  The active tab is pivoted to `null` when it was one of the removed — the
 *  same answer the per-tab path arrived at once the last sibling was gone.
 *  An active tab in a *different* project is left alone. */
export function removeProjectTabs<T extends ClosableTab>(
  tabs: readonly T[],
  activeTabId: string | null,
  projectPath: string,
): TabRemoval<T> {
  const survivors: T[] = [];
  let activeWasRemoved = false;
  for (const t of tabs) {
    if (t.projectPath === projectPath) {
      if (t.id === activeTabId) activeWasRemoved = true;
      continue;
    }
    survivors.push(t);
  }
  return {
    tabs: survivors,
    activeTabId: activeWasRemoved ? null : activeTabId,
  };
}
