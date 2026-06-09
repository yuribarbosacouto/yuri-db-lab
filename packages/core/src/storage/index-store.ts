import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BPlusTree } from "../btree/btree.js";
import type { RowId, Scalar } from "../types.js";

type IndexSnapshot = {
  version: 1;
  table: string;
  column: string;
  entries: Array<{ key: Scalar; rowIds: RowId[] }>;
};

export class IndexStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  save(table: string, column: string, tree: BPlusTree<RowId>): void {
    const snapshot: IndexSnapshot = {
      version: 1,
      table,
      column,
      entries: tree.entries().map((entry) => ({ key: entry.key, rowIds: entry.values })),
    };
    writeFileSync(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  load(table: string, column: string): BPlusTree<RowId> | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as IndexSnapshot;
    if (parsed.version !== 1 || parsed.table !== table || parsed.column !== column) {
      throw new Error(`Index snapshot ${this.filePath} does not match ${table}.${column}`);
    }
    const tree = new BPlusTree<RowId>(32);
    for (const entry of parsed.entries) {
      for (const rowId of entry.rowIds) {
        tree.insert(entry.key, rowId);
      }
    }
    return tree;
  }
}
