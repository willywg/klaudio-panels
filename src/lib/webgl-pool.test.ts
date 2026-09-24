import { describe, expect, test } from "bun:test";
import { createWebglPool } from "./webgl-pool";

describe("createWebglPool", () => {
  test("the first show attaches and a later show of the same id does not", () => {
    const pool = createWebglPool(3);
    expect(pool.show("a")).toEqual({ attach: true, detach: [] });
    expect(pool.show("a")).toEqual({ attach: false, detach: [] });
  });

  test("a visible shell survives any number of agent-tab switches", () => {
    const pool = createWebglPool(3);
    pool.show("A");
    pool.show("S");

    pool.hide("A");
    expect(pool.show("B")).toEqual({ attach: true, detach: [] });

    pool.hide("B");
    expect(pool.show("C")).toEqual({ attach: true, detach: ["A"] });

    pool.hide("C");
    const back = pool.show("A");
    expect(back.attach).toBe(true);
    expect(back.detach).not.toContain("S");
    expect(back.detach).toEqual(["B"]);

    for (const id of ["D", "E", "F", "G"]) {
      pool.hide(id === "D" ? "A" : String.fromCharCode(id.charCodeAt(0) - 1));
      const decision = pool.show(id);
      expect(decision.detach).not.toContain("S");
    }
  });

  test("hide then a new show evicts the hidden id, oldest first", () => {
    const pool = createWebglPool(2);
    pool.show("a");
    pool.show("b");
    pool.hide("a");
    pool.hide("b");
    expect(pool.show("c")).toEqual({ attach: true, detach: ["a"] });
    expect(pool.show("d")).toEqual({ attach: true, detach: ["b"] });
  });

  test("visible holders above the cap evict nothing", () => {
    const pool = createWebglPool(2);
    expect(pool.show("a")).toEqual({ attach: true, detach: [] });
    expect(pool.show("b")).toEqual({ attach: true, detach: [] });
    expect(pool.show("c")).toEqual({ attach: true, detach: [] });
  });

  test("a lost visible id attaches again on the next show", () => {
    const pool = createWebglPool(2);
    pool.show("a");
    pool.show("b");
    pool.lost("a");
    expect(pool.show("a")).toEqual({ attach: true, detach: [] });
  });

  test("release frees a slot without detaching anyone else", () => {
    const pool = createWebglPool(2);
    pool.show("a");
    pool.show("b");
    pool.release("a");
    pool.hide("b");
    expect(pool.show("c")).toEqual({ attach: true, detach: [] });
  });

  test("releasing an unknown id is a no-op", () => {
    const pool = createWebglPool(1);
    pool.release("missing");
    pool.lost("missing");
    pool.hide("missing");
    expect(pool.show("a")).toEqual({ attach: true, detach: [] });
  });
});
