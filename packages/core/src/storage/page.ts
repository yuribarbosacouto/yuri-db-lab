export const PAGE_SIZE = 4096;
const HEADER_SIZE = 4;
const SLOT_SIZE = 4;

export type SlotEntry = {
  slotId: number;
  payload: Buffer;
};

export class SlottedPage {
  private constructor(private readonly buffer: Buffer) {}

  static empty(): SlottedPage {
    const buffer = Buffer.alloc(PAGE_SIZE);
    const page = new SlottedPage(buffer);
    page.setSlotCount(0);
    page.setFreeEnd(PAGE_SIZE);
    return page;
  }

  static from(buffer: Buffer): SlottedPage {
    if (buffer.length !== PAGE_SIZE) {
      throw new Error(`A page must be exactly ${PAGE_SIZE} bytes`);
    }
    if (buffer.readUInt16LE(2) === 0) {
      const page = new SlottedPage(Buffer.from(buffer));
      page.setFreeEnd(PAGE_SIZE);
      return page;
    }
    return new SlottedPage(Buffer.from(buffer));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }

  insert(payload: Buffer): number | null {
    if (payload.length === 0) {
      throw new Error("Cannot insert an empty record into a page");
    }
    if (payload.length > PAGE_SIZE - HEADER_SIZE - SLOT_SIZE) {
      throw new Error(`Record is too large for a ${PAGE_SIZE} byte page`);
    }

    const reusableSlotId = this.findReusableSlot();
    const directoryGrowth = reusableSlotId === null ? SLOT_SIZE : 0;
    if (this.freeBytes() < payload.length + directoryGrowth) return null;

    const newOffset = this.freeEnd() - payload.length;
    payload.copy(this.buffer, newOffset);

    if (reusableSlotId !== null) {
      this.writeSlot(reusableSlotId, newOffset, payload.length);
      this.setFreeEnd(newOffset);
      return reusableSlotId;
    }

    const slotId = this.slotCount();
    this.setSlotCount(slotId + 1);
    this.writeSlot(slotId, newOffset, payload.length);
    this.setFreeEnd(newOffset);
    return slotId;
  }

  read(slotId: number): Buffer | null {
    this.assertSlot(slotId);
    const slot = this.readSlot(slotId);
    if (slot.length === 0) return null;
    return Buffer.from(this.buffer.subarray(slot.offset, slot.offset + slot.length));
  }

  delete(slotId: number): boolean {
    this.assertSlot(slotId);
    const slot = this.readSlot(slotId);
    if (slot.length === 0) return false;
    this.writeSlot(slotId, 0, 0);
    return true;
  }

  scan(): SlotEntry[] {
    const entries: SlotEntry[] = [];
    for (let slotId = 0; slotId < this.slotCount(); slotId += 1) {
      const payload = this.read(slotId);
      if (payload) entries.push({ slotId, payload });
    }
    return entries;
  }

  private slotCount(): number {
    return this.buffer.readUInt16LE(0);
  }

  private setSlotCount(value: number): void {
    this.buffer.writeUInt16LE(value, 0);
  }

  private freeEnd(): number {
    return this.buffer.readUInt16LE(2);
  }

  private setFreeEnd(value: number): void {
    this.buffer.writeUInt16LE(value, 2);
  }

  private freeBytes(): number {
    const directoryEnd = HEADER_SIZE + this.slotCount() * SLOT_SIZE;
    return this.freeEnd() - directoryEnd;
  }

  private findReusableSlot(): number | null {
    for (let slotId = 0; slotId < this.slotCount(); slotId += 1) {
      if (this.readSlot(slotId).length === 0) return slotId;
    }
    return null;
  }

  private readSlot(slotId: number): { offset: number; length: number } {
    const offset = HEADER_SIZE + slotId * SLOT_SIZE;
    return {
      offset: this.buffer.readUInt16LE(offset),
      length: this.buffer.readUInt16LE(offset + 2),
    };
  }

  private writeSlot(slotId: number, recordOffset: number, length: number): void {
    const offset = HEADER_SIZE + slotId * SLOT_SIZE;
    this.buffer.writeUInt16LE(recordOffset, offset);
    this.buffer.writeUInt16LE(length, offset + 2);
  }

  private assertSlot(slotId: number): void {
    if (!Number.isInteger(slotId) || slotId < 0 || slotId >= this.slotCount()) {
      throw new Error(`Slot ${slotId} does not exist`);
    }
  }
}
