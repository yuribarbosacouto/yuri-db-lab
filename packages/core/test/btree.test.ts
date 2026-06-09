import { describe, expect, it } from "vitest";
import { BPlusTree } from "../src/btree/btree.js";

describe("BPlusTree", () => {
  it("keeps keys searchable after several splits", () => {
    const tree = new BPlusTree<number>(4);
    for (let value = 50; value >= 1; value -= 1) {
      tree.insert(value, value * 10);
    }

    expect(tree.search(1)).toEqual([10]);
    expect(tree.search(25)).toEqual([250]);
    expect(tree.search(50)).toEqual([500]);
    expect(tree.search(99)).toEqual([]);
  });

  it("supports duplicate keys and range scans through linked leaves", () => {
    const tree = new BPlusTree<string>(4);
    tree.insert(2, "a");
    tree.insert(2, "b");
    tree.insert(1, "before");
    tree.insert(3, "after");

    expect(tree.search(2)).toEqual(["a", "b"]);
    expect(tree.range(2, 3)).toEqual(["a", "b", "after"]);
  });
});
