import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SlottedPage } from "../src/storage/page.js";
import { PageFile } from "../src/storage/page-file.js";

describe("SlottedPage invariants", () => {
  it("preserves readable records across insert/delete patterns", () => {
    const page = SlottedPage.empty();
    const inserted = new Map<number, string>();

    for (let index = 0; index < 80; index += 1) {
      const value = `record-${index}-${"x".repeat(index % 13)}`;
      const slotId = page.insert(Buffer.from(value, "utf8"));
      expect(slotId).not.toBeNull();
      inserted.set(slotId!, value);
    }

    for (const slotId of [...inserted.keys()].filter((id) => id % 3 === 0)) {
      expect(page.delete(slotId)).toBe(true);
      inserted.delete(slotId);
    }

    for (let index = 80; index < 120; index += 1) {
      const value = `later-${index}`;
      const slotId = page.insert(Buffer.from(value, "utf8"));
      expect(slotId).not.toBeNull();
      inserted.set(slotId!, value);
    }

    const scanned = new Map(page.scan().map((entry) => [entry.slotId, entry.payload.toString("utf8")]));
    expect(scanned).toEqual(inserted);

    const roundTripped = SlottedPage.from(page.toBuffer());
    const reloaded = new Map(roundTripped.scan().map((entry) => [entry.slotId, entry.payload.toString("utf8")]));
    expect(reloaded).toEqual(inserted);
  });

  it("detects corrupted persisted pages with checksums", () => {
    const dir = mkdtempSync(join(tmpdir(), "ydb-page-"));
    const filePath = join(dir, "users.heap");

    try {
      const pageFile = new PageFile(filePath);
      const pageId = pageFile.allocatePage();
      const page = pageFile.readPage(pageId);
      page.insert(Buffer.from("checksum-protected", "utf8"));
      pageFile.writePage(pageId, page);

      const fd = openSync(filePath, "r+");
      try {
        writeSync(fd, Buffer.from([0xff]), 0, 1, 128);
      } finally {
        closeSync(fd);
      }

      expect(() => new PageFile(filePath).readPage(pageId)).toThrow(/checksum mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
