import { describe, expect, test } from "bun:test";
import { mergeSessionListings, type AgentListing } from "./merge-sessions";
import { CLAUDE, CURSOR, type AgentId } from "./agents";

type Row = {
  id: string;
  agent: AgentId;
  created_at: string | null;
  updated_at: string | null;
};

function row(agent: AgentId, id: string, updated: string | null): Row {
  return { id, agent, created_at: null, updated_at: updated };
}

describe("mergeSessionListings", () => {
  test("interleaves agents by recency, not by agent", () => {
    const listings: AgentListing<Row>[] = [
      {
        agent: CLAUDE,
        ok: true,
        sessions: [
          row(CLAUDE, "c-new", "2026-09-22T10:00:00Z"),
          row(CLAUDE, "c-old", "2026-09-20T10:00:00Z"),
        ],
      },
      {
        agent: CURSOR,
        ok: true,
        sessions: [row(CURSOR, "u-mid", "2026-09-21T10:00:00Z")],
      },
    ];
    const merged = mergeSessionListings(listings);
    expect(merged.sessions.map((s) => s.id)).toEqual(["c-new", "u-mid", "c-old"]);
    expect(merged.errors).toEqual([]);
  });

  // The reason this is a merge of per-agent results: Claude's provider fails
  // closed on a direnv error, and that must not blank Cursor's rows.
  test("one provider failing leaves the other's rows and reports the failure", () => {
    const merged = mergeSessionListings<Row>([
      { agent: CLAUDE, ok: false, error: "direnv: .envrc is blocked" },
      {
        agent: CURSOR,
        ok: true,
        sessions: [row(CURSOR, "u", "2026-09-21T10:00:00Z")],
      },
    ]);
    expect(merged.sessions.map((s) => s.id)).toEqual(["u"]);
    expect(merged.errors).toEqual([
      { agent: CLAUDE, error: "direnv: .envrc is blocked" },
    ]);
  });

  test("the same id from two agents stays two rows", () => {
    const merged = mergeSessionListings<Row>([
      { agent: CLAUDE, ok: true, sessions: [row(CLAUDE, "same", "2026-09-21T10:00:00Z")] },
      { agent: CURSOR, ok: true, sessions: [row(CURSOR, "same", "2026-09-21T10:00:00Z")] },
    ]);
    expect(merged.sessions.map((s) => `${s.agent}:${s.id}`)).toEqual([
      "claude:same",
      "cursor:same",
    ]);
  });

  test("rows with no timestamp sink to the bottom", () => {
    const merged = mergeSessionListings<Row>([
      {
        agent: CURSOR,
        ok: true,
        sessions: [row(CURSOR, "undated", null), row(CURSOR, "dated", "2026-01-01T00:00:00Z")],
      },
    ]);
    expect(merged.sessions.map((s) => s.id)).toEqual(["dated", "undated"]);
  });
});
