import type { Row, RowId } from "../types.js";
import { PageFile } from "./page-file.js";

export type HeapEntry = {
  rowId: RowId;
  row: Row;
};

export class HeapFile {
  private readonly pages: PageFile;

  constructor(filePath: string) {
    this.pages = new PageFile(filePath);
  }

  insert(row: Row): RowId {
    const payload = Buffer.from(JSON.stringify(row), "utf8");
    for (let pageId = 0; pageId < this.pages.pageCount(); pageId += 1) {
      const page = this.pages.readPage(pageId);
      const slotId = page.insert(payload);
      if (slotId !== null) {
        this.pages.writePage(pageId, page);
        return { pageId, slotId };
      }
    }

    const pageId = this.pages.allocatePage();
    const page = this.pages.readPage(pageId);
    const slotId = page.insert(payload);
    if (slotId === null) throw new Error("New page unexpectedly rejected a row");
    this.pages.writePage(pageId, page);
    return { pageId, slotId };
  }

  read(rowId: RowId): Row | null {
    const page = this.pages.readPage(rowId.pageId);
    const payload = page.read(rowId.slotId);
    return payload ? decodeRow(payload) : null;
  }

  delete(rowId: RowId): boolean {
    const page = this.pages.readPage(rowId.pageId);
    const deleted = page.delete(rowId.slotId);
    if (deleted) this.pages.writePage(rowId.pageId, page);
    return deleted;
  }

  scan(): HeapEntry[] {
    const entries: HeapEntry[] = [];
    for (let pageId = 0; pageId < this.pages.pageCount(); pageId += 1) {
      const page = this.pages.readPage(pageId);
      for (const entry of page.scan()) {
        entries.push({
          rowId: { pageId, slotId: entry.slotId },
          row: decodeRow(entry.payload),
        });
      }
    }
    return entries;
  }
}

function decodeRow(payload: Buffer): Row {
  const parsed = JSON.parse(payload.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored record is not a row object");
  }
  return parsed as Row;
}
