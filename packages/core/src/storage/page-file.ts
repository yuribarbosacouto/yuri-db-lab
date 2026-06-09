import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { PAGE_SIZE, SlottedPage } from "./page.js";

type PageChecksumManifest = {
  version: 1;
  pages: Record<string, string>;
};

export class PageFile {
  private readonly checksumPath: string;
  private readonly checksumManifest: PageChecksumManifest;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    const fd = openSync(filePath, "a+");
    closeSync(fd);
    this.checksumPath = `${filePath}.checksums.json`;
    this.checksumManifest = readChecksumManifest(this.checksumPath);
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
      this.assertPageChecksum(pageId, buffer);
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
      const buffer = page.toBuffer();
      const bytesWritten = writeSync(fd, buffer, 0, PAGE_SIZE, pageId * PAGE_SIZE);
      if (bytesWritten !== PAGE_SIZE) {
        throw new Error(`Short write while storing page ${pageId}`);
      }
      this.checksumManifest.pages[String(pageId)] = checksumPageBuffer(buffer);
      writeChecksumManifest(this.checksumPath, this.checksumManifest);
    } finally {
      closeSync(fd);
    }
  }

  private assertPageChecksum(pageId: number, buffer: Buffer): void {
    const expected = this.checksumManifest.pages[String(pageId)];
    if (!expected) return;

    const actual = checksumPageBuffer(buffer);
    if (actual !== expected) {
      throw new Error(`Page checksum mismatch in ${this.filePath} page ${pageId}: expected ${expected}, got ${actual}`);
    }
  }
}

export function checksumPageBuffer(buffer: Buffer): string {
  let hash = 0x811c9dc5;
  for (const byte of buffer) {
    hash = Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function readChecksumManifest(filePath: string): PageChecksumManifest {
  if (!existsSync(filePath)) return { version: 1, pages: {} };
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PageChecksumManifest;
  if (parsed.version !== 1 || !parsed.pages || typeof parsed.pages !== "object" || Array.isArray(parsed.pages)) {
    throw new Error(`Page checksum manifest ${filePath} is invalid`);
  }
  return parsed;
}

function writeChecksumManifest(filePath: string, manifest: PageChecksumManifest): void {
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
