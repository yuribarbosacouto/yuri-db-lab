import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BPlusTree } from "../btree/btree.js";
import { compareScalars } from "../sql/evaluator.js";
import type { RowId, Scalar } from "../types.js";
import { PageFile } from "./page-file.js";
import { SlottedPage } from "./page.js";

export type IndexStoreEntry = { key: Scalar; rowIds: RowId[] };

type IndexSnapshot = {
  version: 1;
  table: string;
  column: string;
  entries: IndexStoreEntry[];
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
      entries: IndexStoreEntry[];
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

type PageSplit = {
  separator: Scalar;
  rightPageId: number;
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

  insert(table: string, column: string, key: Scalar, rowId: RowId): void {
    if (key === null) throw new Error("Index keys cannot be null");

    if (!existsSync(this.filePath) || new PageFile(this.filePath).pageCount() === 0) {
      const tree = this.loadLegacySnapshot(table, column) ?? new BPlusTree<RowId>(32);
      tree.insert(key, rowId);
      this.save(table, column, tree);
      return;
    }

    const pageFile = new PageFile(this.filePath);
    const meta = readIndexPage(pageFile, 0);
    assertIndexPage(meta, table, column);
    if (meta.kind !== "meta") throw new Error(`Index store ${this.filePath} page 0 is not a meta page`);

    const split = insertIntoIndexPage(pageFile, table, column, meta.rootPageId, key, rowId);
    const updatedMeta: IndexPage =
      split === null
        ? { ...meta, pageCount: pageFile.pageCount() }
        : {
            ...meta,
            rootPageId: writeNewIndexPage(pageFile, {
              version: 2,
              kind: "internal",
              table,
              column,
              keys: [split.separator],
              children: [meta.rootPageId, split.rightPageId],
            }),
            pageCount: pageFile.pageCount(),
          };
    writeIndexPage(pageFile, 0, updatedMeta);
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

  search(table: string, column: string, key: Scalar): RowId[] {
    if (key === null) return [];
    if (this.hasPagedIndex()) {
      const pageFile = new PageFile(this.filePath);
      const meta = this.readMetaPage(pageFile, table, column);
      const leaf = this.readLeafForKey(pageFile, table, column, meta.rootPageId, key);
      const entry = leaf.entries.find((candidate) => compareScalars(candidate.key, key) === 0);
      return entry ? [...entry.rowIds] : [];
    }

    return this.loadLegacySnapshot(table, column)?.search(key) ?? [];
  }

  range(table: string, column: string, min: Scalar | null, max: Scalar | null): RowId[] {
    if (this.hasPagedIndex()) {
      const pageFile = new PageFile(this.filePath);
      const meta = this.readMetaPage(pageFile, table, column);
      const rowIds: RowId[] = [];
      let pageId: number | null = min === null ? meta.firstLeafPageId : this.findLeafPageId(pageFile, table, column, meta.rootPageId, min);
      const visited = new Set<number>();

      while (pageId !== null) {
        if (visited.has(pageId)) throw new Error(`Index store ${this.filePath} contains a leaf cycle at page ${pageId}`);
        visited.add(pageId);

        const page = readIndexPage(pageFile, pageId);
        assertIndexPage(page, table, column);
        if (page.kind !== "leaf") throw new Error(`Index store ${this.filePath} expected leaf page ${pageId}`);

        for (const entry of page.entries) {
          if (min !== null && compareScalars(entry.key, min) < 0) continue;
          if (max !== null && compareScalars(entry.key, max) > 0) return rowIds;
          rowIds.push(...entry.rowIds);
        }

        pageId = page.nextPageId;
      }

      return rowIds;
    }

    return this.loadLegacySnapshot(table, column)?.range(min, max) ?? [];
  }

  entries(table: string, column: string): IndexStoreEntry[] {
    if (this.hasPagedIndex()) {
      const pageFile = new PageFile(this.filePath);
      const meta = this.readMetaPage(pageFile, table, column);
      const entries: IndexStoreEntry[] = [];
      let pageId: number | null = meta.firstLeafPageId;
      const visited = new Set<number>();

      while (pageId !== null) {
        if (visited.has(pageId)) throw new Error(`Index store ${this.filePath} contains a leaf cycle at page ${pageId}`);
        visited.add(pageId);

        const page = readIndexPage(pageFile, pageId);
        assertIndexPage(page, table, column);
        if (page.kind !== "leaf") throw new Error(`Index store ${this.filePath} expected leaf page ${pageId}`);
        entries.push(...page.entries.map((entry) => ({ key: entry.key, rowIds: [...entry.rowIds] })));
        pageId = page.nextPageId;
      }

      return entries;
    }

    return this.loadLegacySnapshot(table, column)?.entries().map((entry) => ({ key: entry.key, rowIds: [...entry.values] })) ?? [];
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

  private hasPagedIndex(): boolean {
    return existsSync(this.filePath) && new PageFile(this.filePath).pageCount() > 0;
  }

  private readMetaPage(pageFile: PageFile, table: string, column: string): Extract<IndexPage, { kind: "meta" }> {
    const meta = readIndexPage(pageFile, 0);
    assertIndexPage(meta, table, column);
    if (meta.kind !== "meta") throw new Error(`Index store ${this.filePath} page 0 is not a meta page`);
    return meta;
  }

  private readLeafForKey(pageFile: PageFile, table: string, column: string, rootPageId: number, key: Scalar): Extract<IndexPage, { kind: "leaf" }> {
    const leafPageId = this.findLeafPageId(pageFile, table, column, rootPageId, key);
    const leaf = readIndexPage(pageFile, leafPageId);
    assertIndexPage(leaf, table, column);
    if (leaf.kind !== "leaf") throw new Error(`Index store ${this.filePath} expected leaf page ${leafPageId}`);
    return leaf;
  }

  private findLeafPageId(pageFile: PageFile, table: string, column: string, rootPageId: number, key: Scalar): number {
    let pageId = rootPageId;
    const visited = new Set<number>();

    while (true) {
      if (visited.has(pageId)) throw new Error(`Index store ${this.filePath} contains a page cycle at page ${pageId}`);
      visited.add(pageId);

      const page = readIndexPage(pageFile, pageId);
      assertIndexPage(page, table, column);

      if (page.kind === "leaf") return pageId;
      if (page.kind !== "internal") throw new Error(`Index store ${this.filePath} cannot descend through ${page.kind} page ${pageId}`);

      const childIndex = findChildIndex(page.keys, key);
      const childPageId = page.children[childIndex];
      if (childPageId === undefined) throw new Error(`Index internal page ${pageId} points to a missing child`);
      pageId = childPageId;
    }
  }
}

function resetPageFile(filePath: string): void {
  writeFileSync(filePath, "");
  rmSync(`${filePath}.checksums.json`, { force: true });
}

function chunkIndexEntries(entries: IndexStoreEntry[]): IndexStoreEntry[][] {
  const chunks: IndexStoreEntry[][] = [];
  let current: IndexStoreEntry[] = [];

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

function writeNewIndexPage(pageFile: PageFile, page: IndexPage): number {
  const pageId = pageFile.pageCount();
  writeIndexPage(pageFile, pageId, page);
  return pageId;
}

function insertIntoIndexPage(
  pageFile: PageFile,
  table: string,
  column: string,
  pageId: number,
  key: Scalar,
  rowId: RowId,
): PageSplit | null {
  const page = readIndexPage(pageFile, pageId);
  assertIndexPage(page, table, column);

  if (page.kind === "leaf") {
    return insertIntoLeafPage(pageFile, pageId, page, key, rowId);
  }

  if (page.kind !== "internal") {
    throw new Error(`Cannot insert into ${page.kind} index page ${pageId}`);
  }

  const childIndex = findChildIndex(page.keys, key);
  const childPageId = page.children[childIndex];
  if (childPageId === undefined) throw new Error(`Index internal page ${pageId} points to a missing child`);

  const childSplit = insertIntoIndexPage(pageFile, table, column, childPageId, key, rowId);
  if (!childSplit) return null;

  const nextKeys = [...page.keys];
  const nextChildren = [...page.children];
  nextKeys.splice(childIndex, 0, childSplit.separator);
  nextChildren.splice(childIndex + 1, 0, childSplit.rightPageId);

  const updated: IndexPage = { ...page, keys: nextKeys, children: nextChildren };
  if (fitsIndexPage(updated)) {
    writeIndexPage(pageFile, pageId, updated);
    return null;
  }

  return splitInternalPage(pageFile, pageId, updated);
}

function insertIntoLeafPage(pageFile: PageFile, pageId: number, page: Extract<IndexPage, { kind: "leaf" }>, key: Scalar, rowId: RowId): PageSplit | null {
  const entries = insertIndexEntry(page.entries, key, rowId);
  const updated: IndexPage = { ...page, entries };
  if (fitsIndexPage(updated)) {
    writeIndexPage(pageFile, pageId, updated);
    return null;
  }

  return splitLeafPage(pageFile, pageId, updated);
}

function splitLeafPage(pageFile: PageFile, pageId: number, page: Extract<IndexPage, { kind: "leaf" }>): PageSplit {
  const midpoint = Math.ceil(page.entries.length / 2);
  const leftEntries = page.entries.slice(0, midpoint);
  const rightEntries = page.entries.slice(midpoint);
  const separator = rightEntries[0]?.key;
  if (separator === undefined) throw new Error(`Cannot split index leaf page ${pageId} without a separator`);

  const rightPageId = pageFile.pageCount();
  const left: IndexPage = { ...page, entries: leftEntries, nextPageId: rightPageId };
  const right: IndexPage = { ...page, entries: rightEntries, nextPageId: page.nextPageId };

  if (!fitsIndexPage(left) || !fitsIndexPage(right)) {
    throw new Error(`Index leaf page ${pageId} cannot be split into valid pages`);
  }

  writeIndexPage(pageFile, pageId, left);
  writeIndexPage(pageFile, rightPageId, right);
  return { separator, rightPageId };
}

function splitInternalPage(pageFile: PageFile, pageId: number, page: Extract<IndexPage, { kind: "internal" }>): PageSplit {
  const midpoint = Math.floor(page.keys.length / 2);
  const separator = page.keys[midpoint];
  if (separator === undefined) throw new Error(`Cannot split index internal page ${pageId} without a separator`);

  const left: IndexPage = {
    ...page,
    keys: page.keys.slice(0, midpoint),
    children: page.children.slice(0, midpoint + 1),
  };
  const right: IndexPage = {
    ...page,
    keys: page.keys.slice(midpoint + 1),
    children: page.children.slice(midpoint + 1),
  };

  if (!fitsIndexPage(left) || !fitsIndexPage(right)) {
    throw new Error(`Index internal page ${pageId} cannot be split into valid pages`);
  }

  const rightPageId = pageFile.pageCount();
  writeIndexPage(pageFile, pageId, left);
  writeIndexPage(pageFile, rightPageId, right);
  return { separator, rightPageId };
}

function insertIndexEntry(entries: IndexStoreEntry[], key: Scalar, rowId: RowId): IndexStoreEntry[] {
  if (!fitsIndexPage({ version: 2, kind: "leaf", table: "", column: "", nextPageId: null, entries: [{ key, rowIds: [rowId] }] })) {
    throw new Error(`Index entry for key ${String(key)} is too large for one index page`);
  }

  const next = entries.map((entry) => ({ key: entry.key, rowIds: [...entry.rowIds] }));
  const index = findInsertIndex(next.map((entry) => entry.key), key);
  if (index < next.length && compareScalars(next[index]!.key, key) === 0) {
    if (!next[index]!.rowIds.some((candidate) => rowIdEquals(candidate, rowId))) {
      next[index]!.rowIds.push(rowId);
    }
  } else {
    next.splice(index, 0, { key, rowIds: [rowId] });
  }
  return next;
}

function findInsertIndex(keys: Scalar[], key: Scalar): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (compareScalars(keys[mid]!, key) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findChildIndex(keys: Scalar[], key: Scalar): number {
  let index = 0;
  while (index < keys.length && compareScalars(key, keys[index]!) >= 0) {
    index += 1;
  }
  return index;
}

function rowIdEquals(left: RowId, right: RowId): boolean {
  return left.pageId === right.pageId && left.slotId === right.slotId;
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
