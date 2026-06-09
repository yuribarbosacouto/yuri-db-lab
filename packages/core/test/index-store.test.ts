import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BPlusTree } from "../src/btree/btree.js";
import { PageFile } from "../src/storage/page-file.js";
import { IndexStore } from "../src/storage/index-store.js";
import type { RowId } from "../src/types.js";

describe("IndexStore", () => {
  it("persists B+Tree snapshots as page-backed index files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ydb-index-"));
    const filePath = join(dir, "users.age.idx");

    try {
      const tree = new BPlusTree<RowId>(4);
      for (let id = 1; id <= 120; id += 1) {
        tree.insert(20 + (id % 30), { pageId: Math.floor(id / 10), slotId: id % 10 });
      }

      const store = new IndexStore(filePath);
      store.save("users", "age", tree);

      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(`${filePath}.checksums.json`)).toBe(true);
      const info = store.inspect("users", "age");
      expect(info).toMatchObject({ format: "paged-btree", rootPageId: expect.any(Number) });
      expect(info.rootPageId).not.toBe(info.firstLeafPageId);
      expect(new PageFile(filePath).pageCount()).toBeGreaterThan(2);

      const loaded = store.load("users", "age");

      expect(loaded?.search(25)).toEqual(tree.search(25));
      expect(loaded?.range(30, 32)).toEqual(tree.range(30, 32));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads legacy JSON snapshots when no page-backed index exists yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "ydb-index-"));
    const filePath = join(dir, "users.id.idx");
    const legacyPath = `${filePath}.json`;

    try {
      writeFileSync(
        legacyPath,
        `${JSON.stringify(
          {
            version: 1,
            table: "users",
            column: "id",
            entries: [{ key: 1, rowIds: [{ pageId: 0, slotId: 0 }] }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = new IndexStore(filePath);
      const loaded = store.load("users", "id");

      expect(store.inspect("users", "id")).toEqual({ format: "legacy-json", pageCount: 0 });
      expect(loaded?.search(1)).toEqual([{ pageId: 0, slotId: 0 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports mutable inserts with leaf and root splits in page-backed indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ydb-index-"));
    const filePath = join(dir, "users.id.idx");

    try {
      const store = new IndexStore(filePath);
      store.save("users", "id", new BPlusTree<RowId>(4));

      for (let id = 1; id <= 180; id += 1) {
        store.insert("users", "id", id, { pageId: Math.floor(id / 12), slotId: id % 12 });
      }

      const info = store.inspect("users", "id");
      const loaded = store.load("users", "id");

      expect(info.format).toBe("paged-btree");
      expect(info.rootPageId).not.toBe(info.firstLeafPageId);
      expect(info.pageCount).toBeGreaterThan(2);
      expect(loaded?.search(1)).toEqual([{ pageId: 0, slotId: 1 }]);
      expect(loaded?.search(180)).toEqual([{ pageId: 15, slotId: 0 }]);
      expect(loaded?.range(40, 42)).toEqual([
        { pageId: 3, slotId: 4 },
        { pageId: 3, slotId: 5 },
        { pageId: 3, slotId: 6 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
