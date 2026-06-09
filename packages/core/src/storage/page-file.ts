import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { PAGE_SIZE, SlottedPage } from "./page.js";

export class PageFile {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    const fd = openSync(filePath, "a+");
    closeSync(fd);
  }

  pageCount(): number {
    if (!existsSync(this.filePath)) return 0;
    const fd = openSync(this.filePath, "r");
    try {
      return Math.floor(fstatSync(fd).size / PAGE_SIZE);
    } finally {
      closeSync(fd);
    }
  }

  allocatePage(): number {
    const pageId = this.pageCount();
    this.writePage(pageId, SlottedPage.empty());
    return pageId;
  }

  readPage(pageId: number): SlottedPage {
    if (!Number.isInteger(pageId) || pageId < 0 || pageId >= this.pageCount()) {
      throw new Error(`Page ${pageId} does not exist in ${this.filePath}`);
    }

    const fd = openSync(this.filePath, "r");
    try {
      const buffer = Buffer.alloc(PAGE_SIZE);
      const bytesRead = readSync(fd, buffer, 0, PAGE_SIZE, pageId * PAGE_SIZE);
      if (bytesRead !== PAGE_SIZE) {
        throw new Error(`Short read while loading page ${pageId}`);
      }
      return SlottedPage.from(buffer);
    } finally {
      closeSync(fd);
    }
  }

  writePage(pageId: number, page: SlottedPage): void {
    if (!Number.isInteger(pageId) || pageId < 0) {
      throw new Error(`Invalid page id: ${pageId}`);
    }

    const fd = openSync(this.filePath, "r+");
    try {
      const bytesWritten = writeSync(fd, page.toBuffer(), 0, PAGE_SIZE, pageId * PAGE_SIZE);
      if (bytesWritten !== PAGE_SIZE) {
        throw new Error(`Short write while storing page ${pageId}`);
      }
    } finally {
      closeSync(fd);
    }
  }
}
