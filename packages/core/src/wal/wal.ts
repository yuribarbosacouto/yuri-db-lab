import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IndexSchema, Row, RowId, TableSchema } from "../types.js";

export type WalRecord =
  | { txId: number; type: "begin"; at: string }
  | { txId: number; type: "commit"; at: string }
  | { txId: number; type: "rollback"; at: string }
  | { txId: number; type: "create_table"; at: string; schema: TableSchema }
  | { txId: number; type: "create_index"; at: string; index: IndexSchema }
  | { txId: number; type: "insert"; at: string; table: string; row: Row }
  | { txId: number; type: "insert_applied"; at: string; table: string; rowId: RowId }
  | { txId: number; type: "update"; at: string; table: string; before: Row; after: Row }
  | { txId: number; type: "delete"; at: string; table: string; rowId: RowId; row: Row };

type WithoutTimestamp<T> = T extends unknown ? Omit<T, "at"> : never;
type WalRecordInput = WithoutTimestamp<WalRecord>;

export class WriteAheadLog {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) appendFileSync(filePath, "", "utf8");
  }

  append(record: WalRecordInput): void {
    const hydrated = { ...record, at: new Date().toISOString() } as WalRecord;
    appendFileSync(this.filePath, `${JSON.stringify(hydrated)}\n`, "utf8");
  }

  readAll(): WalRecord[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf8").trim();
    if (!content) return [];
    return content.split(/\r?\n/).map((line) => JSON.parse(line) as WalRecord);
  }
}
