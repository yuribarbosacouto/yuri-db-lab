import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BPlusTree } from "../btree/btree.js";
import type { RowId, Scalar } from "../types.js";
import { PageFile } from "./page-file.js";
import { SlottedPage } from "./page.js";

type IndexSnapshot = {
  version: 1;
  table: string;
  column: string;
  entries: Array<{ key: Scalar; rowIds: RowId[] }>;
};

type IndexPage =
  | {
      version: 2;
      kind: "meta";
      table: string;
      column: string;
      rootPageId: number;
      firstLeafPageId: number;
      pageCount: number;
    }
  | {
      version: 2;
      kind: "leaf";
      table: string;
      column: string;
      nextPageId: number | null;
      entries: Array<{ key: Scalar; rowIds: RowId[] }>;
    }
  | {
      version: 2;
      kind: "internal";
      table: string;
      column: string;
      keys: Scalar[];
      children: number[];
    };

type ChildRef = {
  pageId: number;
  firstKey: Scalar | null;
};

export type IndexStoreInfo = {
  format: "paged-btree" | "legacy-json" | "empty";
  pageCount: number;
  rootPageId?: number;
  firstLeafPageId?: number;
};

const MAX_INDEX_PAGE_PAYLOAD_BYTES = 3400;

export class IndexStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  save(table: string, column: string, tree: BPlusTree<RowId>): void {
    resetPageFile(this.filePath);
    const pageFile = new PageFile(this.filePath);
    const leafChunks = chunkIndexEntries(tree.entries().map((entry) => ({ key: entry.key, rowIds: entry.values })));
    const leafRefs: ChildRef[] = [];
    let nextPageId = 1;

    const leafPageIds = leafChunks.map(() => nextPageId++);
    for (let index = 0; index < leafChunks.length; index += 1) {
      const pageId = leafPageIds[index]!;
      const entries = leafChunks[index]!;
      const leaf: IndexPage = {
        version: 2,
        kind: "leaf",
        table,
        column,
        nextPageId: leafPageIds[index + 1] ?? null,
        entries,
      };
      writeIndexPage(pageFile, pageId, leaf);
      leafRefs.push({ pageId, firstKey: entries[0]?.key ?? null });
    }

    const rootPageId = buildInternalIndexPages(pageFile, table, column, leafRefs, nextPageId);
    const pageCount = pageFile.pageCount();
    const meta: IndexPage = {
      version: 2,
      kind: "meta",
      table,
      column,
      rootPageId,
      firstLeafPageId: leafRefs[0]?.pageId ?? rootPageId,
      pageCount,
    };
    writeIndexPage(pageFile, 0, meta);
  }

  load(table: string, column: string): BPlusTree<RowId> | null {
    if (existsSync(this.filePath) && new PageFile(this.filePath).pageCount() > 0) {
      return this.loadPagedTree(table, column);
    }
    return this.loadLegacySnapshot(table, column);
  }

  inspect(table: string, column: string): IndexStoreInfo {
    if (existsSync(this.filePath) && new PageFile(this.filePath).pageCount() > 0) {
      const pageFile = new PageFile(this.filePath);
      const meta = readIndexPage(pageFile, 0);
      assertIndexPage(meta, table, column);
      if (meta.kind !== "meta") throw new Error(`Index store ${this.filePath} page 0 is not a meta page`);
      return {
        format: "paged-btree",
        pageCount: pageFile.pageCount(),
        rootPageId: meta.rootPageId,
        firstLeafPageId: meta.firstLeafPageId,
      };
    }
    if (existsSync(this.legacyPath())) return { format: "legacy-json", pageCount: 0 };
    return { format: "empty", pageCount: 0 };
  }

  private loadPagedTree(table: string, column: string): BPlusTree<RowId> {
    const pageFile = new PageFile(this.filePath);
    const meta = readIndexPage(pageFile, 0);
    assertIndexPage(meta, table, column);
    if (meta.kind !== "meta") throw new Error(`Index store ${this.filePath} page 0 is not a meta page`);

    const tree = new BPlusTree<RowId>(32);
    let pageId: number | null = meta.firstLeafPageId;
    const visited = new Set<number>();

    while (pageId !== null) {
      if (visited.has(pageId)) throw new Error(`Index store ${this.filePath} contains a leaf cycle at page ${pageId}`);
      visited.add(pageId);

      const page = readIndexPage(pageFile, pageId);
      assertIndexPage(page, table, column);
      if (page.kind !== "leaf") throw new Error(`Index store ${this.filePath} expected leaf page ${pageId}`);

      for (const entry of page.entries) {
        for (const rowId of entry.rowIds) {
          tree.insert(entry.key, rowId);
        }
      }
      pageId = page.nextPageId;
    }

    return tree;
  }

  private loadLegacySnapshot(table: string, column: string): BPlusTree<RowId> | null {
    const legacyPath = this.legacyPath();
    if (!existsSync(legacyPath)) return null;
    const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as IndexSnapshot;
    if (parsed.version !== 1 || parsed.table !== table || parsed.column !== column) {
      throw new Error(`Index snapshot ${legacyPath} does not match ${table}.${column}`);
    }
    const tree = new BPlusTree<RowId>(32);
    for (const entry of parsed.entries) {
      for (const rowId of entry.rowIds) {
        tree.insert(entry.key, rowId);
      }
    }
    return tree;
  }

  private legacyPath(): string {
    return `${this.filePath}.json`;
  }
}

function resetPageFile(filePath: string): void {
  writeFileSync(filePath, "");
  rmSync(`${filePath}.checksums.json`, { force: true });
}

function chunkIndexEntries(entries: Array<{ key: Scalar; rowIds: RowId[] }>): Array<Array<{ key: Scalar; rowIds: RowId[] }>> {
  const chunks: Array<Array<{ key: Scalar; rowIds: RowId[] }>> = [];
  let current: Array<{ key: Scalar; rowIds: RowId[] }> = [];

  for (const entry of entries) {
    if (!fitsIndexPage({ version: 2, kind: "leaf", table: "", column: "", nextPageId: null, entries: [entry] })) {
      throw new Error(`Index entry for key ${String(entry.key)} is too large for one index page`);
    }

    const candidate = [...current, entry];
    if (current.length > 0 && !fitsIndexPage({ version: 2, kind: "leaf", table: "", column: "", nextPageId: null, entries: candidate })) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }

  chunks.push(current);
  return chunks;
}

function buildInternalIndexPages(
  pageFile: PageFile,
  table: string,
  column: string,
  initialRefs: ChildRef[],
  nextPageId: number,
): number {
  let level = initialRefs;
  let next = nextPageId;

  while (level.length > 1) {
    const groups = chunkChildRefs(level);
    const parentRefs: ChildRef[] = [];

    for (const group of groups) {
      const pageId = next;
      next += 1;
      const page: IndexPage = {
        version: 2,
        kind: "internal",
        table,
        column,
        children: group.map((child) => child.pageId),
        keys: group.slice(1).map((child) => child.firstKey),
      };
      writeIndexPage(pageFile, pageId, page);
      parentRefs.push({ pageId, firstKey: group[0]?.firstKey ?? null });
    }

    level = parentRefs;
  }

  const rootPageId = level[0]?.pageId;
  if (rootPageId === undefined) throw new Error("Cannot build an index tree without a root page");
  return rootPageId;
}

function chunkChildRefs(refs: ChildRef[]): ChildRef[][] {
  const chunks: ChildRef[][] = [];
  let current: ChildRef[] = [];

  for (const ref of refs) {
    const candidate = [...current, ref];
    const page: IndexPage = {
      version: 2,
      kind: "internal",
      table: "",
      column: "",
      keys: candidate.slice(1).map((child) => child.firstKey),
      children: candidate.map((child) => child.pageId),
    };
    if (current.length > 0 && !fitsIndexPage(page)) {
      chunks.push(current);
      current = [ref];
    } else {
      current = candidate;
    }
  }

  chunks.push(current);
  return chunks;
}

function writeIndexPage(pageFile: PageFile, pageId: number, page: IndexPage): void {
  const payload = Buffer.from(JSON.stringify(page), "utf8");
  const slotted = SlottedPage.empty();
  const slotId = slotted.insert(payload);
  if (slotId === null) throw new Error(`Index page ${pageId} is too large`);
  while (pageFile.pageCount() <= pageId) pageFile.allocatePage();
  pageFile.writePage(pageId, slotted);
}

function readIndexPage(pageFile: PageFile, pageId: number): IndexPage {
  const page = pageFile.readPage(pageId);
  const entries = page.scan();
  if (entries.length !== 1) throw new Error(`Index page ${pageId} expected exactly one payload`);
  return JSON.parse(entries[0]!.payload.toString("utf8")) as IndexPage;
}

function assertIndexPage(page: IndexPage, table: string, column: string): void {
  if (page.version !== 2 || page.table !== table || page.column !== column) {
    throw new Error(`Index page does not match ${table}.${column}`);
  }
}

function fitsIndexPage(page: IndexPage): boolean {
  return Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_INDEX_PAGE_PAYLOAD_BYTES;
}
