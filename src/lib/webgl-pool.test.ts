import { describe, expect, test } from "bun:test";
import { createWebglPool } from "./webgl-pool";

describe("createWebglPool", () => {
  test("the first touch attaches and later touches of the same id do not", () => {
    const pool = createWebglPool(3);
    expect(pool.touch("a")).toEqual({ attach: true, detach: [] });
    expect(pool.touch("a")).toEqual({ attach: false, detach: [] });
  });

  test("ids past the cap detach oldest-first", () => {
    const pool = createWebglPool(3);
    pool.touch("a");
    pool.touch("b");
    pool.touch("c");
    expect(pool.touch("d")).toEqual({ attach: true, detach: ["a"] });
    expect(pool.touch("e")).toEqual({ attach: true, detach: ["b"] });
  });

  test("touching an attached id makes it newest, so the next eviction skips it", () => {
    const pool = createWebglPool(2);
    pool.touch("a");
    pool.touch("b");
    expect(pool.touch("a")).toEqual({ attach: false, detach: [] });
    expect(pool.touch("c")).toEqual({ attach: true, detach: ["b"] });
  });

  test("release frees a slot without detaching anyone else", () => {
    const pool = createWebglPool(2);
    pool.touch("a");
    pool.touch("b");
    pool.release("a");
    expect(pool.touch("c")).toEqual({ attach: true, detach: [] });
  });

  test("a lost id attaches again on the next touch", () => {
    const pool = createWebglPool(2);
    pool.touch("a");
    pool.touch("b");
    pool.lost("a");
    expect(pool.touch("a")).toEqual({ attach: true, detach: [] });
    expect(pool.touch("c")).toEqual({ attach: true, detach: ["b"] });
  });

  test("releasing an unknown id is a no-op", () => {
    const pool = createWebglPool(1);
    pool.release("missing");
    pool.lost("missing");
    expect(pool.touch("a")).toEqual({ attach: true, detach: [] });
  });
});
