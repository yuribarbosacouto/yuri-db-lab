import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BPlusTree } from "../btree/btree.js";
import { Catalog } from "../catalog/catalog.js";
import { planSelect } from "../planner/planner.js";
import { compareScalars, matches } from "../sql/evaluator.js";
import { parseSql } from "../sql/parser.js";
import type {
  ColumnSchema,
  IndexSchema,
  OrderBy,
  Predicate,
  QueryResult,
  QueryPlan,
  RecoveryReport,
  Row,
  RowId,
  Scalar,
  StartupRecoveryReport,
  Statement,
  TableSchema,
} from "../types.js";
import { HeapFile } from "../storage/heap-file.js";
import type { HeapEntry } from "../storage/heap-file.js";
import { IndexStore } from "../storage/index-store.js";
import { WriteAheadLog } from "../wal/wal.js";
import type { WalRecord } from "../wal/wal.js";

type ActiveTransaction = {
  txId: number;
  statements: Statement[];
};

type IndexMap = Map<string, BPlusTree<RowId>>;
type WalRecordInput = Parameters<WriteAheadLog["append"]>[0];
type YuriDatabaseOptions = {
  recoverOnOpen?: boolean;
};

export class YuriDatabase {
  private readonly catalog: Catalog;
  private readonly wal: WriteAheadLog;
  private readonly heaps = new Map<string, HeapFile>();
  private readonly indexes: IndexMap = new Map();
  private readonly startupRecoveryReport: StartupRecoveryReport | null;
  private activeTransaction: ActiveTransaction | null = null;
  private logicalWalRecordsWritten = 0;
  private txCounter = Date.now();

  constructor(private readonly dataDir: string, options: YuriDatabaseOptions = {}) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "tables"), { recursive: true });
    mkdirSync(join(dataDir, "indexes"), { recursive: true });
    this.catalog = new Catalog(join(dataDir, "catalog.json"));
    this.wal = new WriteAheadLog(join(dataDir, "wal.jsonl"));
    this.startupRecoveryReport = options.recoverOnOpen === false ? null : this.recoverWalOnOpen();
    for (const table of this.catalog.listTables()) {
      this.heapFor(table.name);
      this.loadOrRebuildTableIndexes(table);
    }
  }

  execute(sqlOrStatement: string | Statement): QueryResult {
    const started = performance.now();
    const statement = typeof sqlOrStatement === "string" ? parseSql(sqlOrStatement) : sqlOrStatement;
    const result = this.executeStatement(statement);
    return {
      ...result,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
    };
  }

  listTables(): TableSchema[] {
    return this.catalog.listTables();
  }

  startupRecovery(): StartupRecoveryReport | null {
    return this.startupRecoveryReport ? { ...this.startupRecoveryReport } : null;
  }

  static recoverFromWal(sourceDir: string, targetDir: string): RecoveryReport {
    if (existsSync(targetDir)) {
      throw new Error(`Recovery target already exists: ${targetDir}`);
    }

    const records = new WriteAheadLog(join(sourceDir, "wal.jsonl")).readAll();
    const recovered = new YuriDatabase(targetDir, { recoverOnOpen: false });
    let pending: WalRecord[] | null = null;
    let recordsApplied = 0;
    let transactionsCommitted = 0;
    let transactionsRolledBack = 0;
    let invalidCommitMarkers = 0;

    for (const record of records) {
      if (record.type === "begin") {
        pending = [];
        continue;
      }
      if (record.type === "rollback") {
        pending = null;
        transactionsRolledBack += 1;
        continue;
      }
      if (record.type === "commit") {
        if (!recovered.isCommitMarkerValid(record, pending ?? [])) {
          pending = null;
          invalidCommitMarkers += 1;
          continue;
        }
        for (const queued of pending ?? []) {
          if (recovered.applyRecoveredWalRecord(queued)) recordsApplied += 1;
        }
        pending = null;
        transactionsCommitted += 1;
        continue;
      }
      if (record.type === "insert_applied") continue;

      if (pending) pending.push(record);
      else if (recovered.applyRecoveredWalRecord(record)) recordsApplied += 1;
    }
    recovered.rebuildAllIndexes();

    return {
      sourceDir,
      targetDir,
      recordsRead: records.length,
      recordsApplied,
      transactionsCommitted,
      transactionsRolledBack,
      invalidCommitMarkers,
    };
  }

  private executeStatement(statement: Statement): Omit<QueryResult, "elapsedMs"> {
    if (statement.kind === "begin") return this.begin();
    if (statement.kind === "commit") return this.commit();
    if (statement.kind === "rollback") return this.rollback();

    if (this.activeTransaction && statement.kind !== "select") {
      if (statement.kind === "create_table" || statement.kind === "create_index") {
        throw new Error(`${statement.kind} is intentionally kept outside transactions in this lab`);
      }
      this.activeTransaction.statements.push(statement);
      return emptyResult(`queued ${statement.kind} in tx ${this.activeTransaction.txId}`);
    }

    return this.applyStatement(statement, this.nextAutocommitTxId());
  }

  private begin(): Omit<QueryResult, "elapsedMs"> {
    if (this.activeTransaction) {
      throw new Error(`Transaction ${this.activeTransaction.txId} is already active`);
    }
    const txId = this.nextAutocommitTxId();
    this.activeTransaction = { txId, statements: [] };
    this.wal.append({ txId, type: "begin" });
    return emptyResult(`began transaction ${txId}`);
  }

  private commit(): Omit<QueryResult, "elapsedMs"> {
    if (!this.activeTransaction) throw new Error("No active transaction");
    const transaction = this.activeTransaction;
    const recordsBeforeCommit = this.logicalWalRecordsWritten;
    for (const statement of transaction.statements) {
      this.applyStatement(statement, transaction.txId);
    }
    const recordCount = this.logicalWalRecordsWritten - recordsBeforeCommit;
    this.wal.append({ txId: transaction.txId, type: "commit", recordCount });
    this.activeTransaction = null;
    return emptyResult(`committed ${transaction.statements.length} statements in tx ${transaction.txId}`);
  }

  private rollback(): Omit<QueryResult, "elapsedMs"> {
    if (!this.activeTransaction) throw new Error("No active transaction");
    const transaction = this.activeTransaction;
    this.wal.append({ txId: transaction.txId, type: "rollback" });
    this.activeTransaction = null;
    return emptyResult(`rolled back ${transaction.statements.length} queued statements`);
  }

  private recoverWalOnOpen(): StartupRecoveryReport {
    const records = this.wal.readAll();
    let pending: WalRecord[] | null = null;
    let recordsApplied = 0;
    let recordsUndone = 0;
    let transactionsCommitted = 0;
    let transactionsRolledBack = 0;
    let incompleteTransactionsDiscarded = 0;
    let invalidCommitMarkers = 0;

    for (const record of records) {
      if (record.type === "begin") {
        if (pending) {
          recordsUndone += this.undoRecoveredWalBatch(pending);
          incompleteTransactionsDiscarded += 1;
        }
        pending = [];
        continue;
      }

      if (record.type === "rollback") {
        if (pending) recordsUndone += this.undoRecoveredWalBatch(pending);
        pending = null;
        transactionsRolledBack += 1;
        continue;
      }

      if (record.type === "commit") {
        if (!this.isCommitMarkerValid(record, pending ?? [])) {
          if (pending) recordsUndone += this.undoRecoveredWalBatch(pending);
          pending = null;
          invalidCommitMarkers += 1;
          continue;
        }
        for (const queued of pending ?? []) {
          if (this.applyRecoveredWalRecord(queued)) recordsApplied += 1;
        }
        pending = null;
        transactionsCommitted += 1;
        continue;
      }

      if (record.type === "insert_applied") continue;

      if (pending) {
        pending.push(record);
      } else if (this.applyRecoveredWalRecord(record)) {
        recordsApplied += 1;
      }
    }

    if (pending) {
      recordsUndone += this.undoRecoveredWalBatch(pending);
      incompleteTransactionsDiscarded += 1;
    }

    this.rebuildAllIndexes();

    return {
      dataDir: this.dataDir,
      recordsRead: records.length,
      recordsApplied,
      recordsUndone,
      transactionsCommitted,
      transactionsRolledBack,
      incompleteTransactionsDiscarded,
      invalidCommitMarkers,
    };
  }

  private isCommitMarkerValid(record: Extract<WalRecord, { type: "commit" }>, pending: WalRecord[]): boolean {
    if (record.recordCount === undefined) return true;
    return record.recordCount === pending.length;
  }

  private undoRecoveredWalBatch(records: WalRecord[]): number {
    let recordsUndone = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (this.undoRecoveredWalRecord(records[index]!)) recordsUndone += 1;
    }
    return recordsUndone;
  }

  private undoRecoveredWalRecord(record: WalRecord): boolean {
    switch (record.type) {
      case "insert":
        return this.deleteRecoveredRow(record.table, record.row);
      case "update": {
        const removedAfter = this.deleteRecoveredRow(record.table, record.after);
        const restoredBefore = this.insertRecoveredRow(record.table, record.before);
        return removedAfter || restoredBefore;
      }
      case "delete":
        return this.insertRecoveredRow(record.table, record.row);
      case "begin":
      case "commit":
      case "rollback":
      case "create_table":
      case "create_index":
      case "insert_applied":
        return false;
    }
  }

  private applyRecoveredWalRecord(record: WalRecord): boolean {
    switch (record.type) {
      case "create_table":
        if (!this.catalog.getTable(record.schema.name)) {
          this.catalog.createTable(record.schema);
          this.heapFor(record.schema.name);
          this.loadOrRebuildTableIndexes(this.requireTable(record.schema.name));
          return true;
        }
        return false;
      case "create_index":
        if (!this.catalog.getIndex(record.index.table, record.index.column)) {
          this.catalog.createIndex(record.index);
          this.rebuildIndex(record.index.table, record.index.column, record.index);
          return true;
        }
        return false;
      case "insert":
        return this.insertRecoveredRow(record.table, record.row);
      case "update":
        this.deleteRecoveredRow(record.table, record.before);
        return this.insertRecoveredRow(record.table, record.after);
      case "delete":
        return this.deleteRecoveredRow(record.table, record.row);
      case "begin":
      case "commit":
      case "rollback":
      case "insert_applied":
        return false;
    }
  }

  private applyStatement(statement: Statement, txId: number): Omit<QueryResult, "elapsedMs"> {
    switch (statement.kind) {
      case "create_table":
        return this.createTable(statement.table, txId);
      case "create_index":
        return this.createIndex(statement.index, txId);
      case "insert":
        return this.insert(statement.table, statement.columns, statement.values, txId);
      case "select":
        return this.select(statement.table, statement.columns, statement.where, statement.orderBy, statement.limit);
      case "update":
        return this.update(statement.table, statement.set, statement.where, txId);
      case "delete":
        return this.delete(statement.table, statement.where, txId);
      default:
        throw new Error(`Unsupported statement in apply phase: ${statement.kind}`);
    }
  }

  private createTable(schema: TableSchema, txId: number): Omit<QueryResult, "elapsedMs"> {
    this.appendLogicalWalRecord({ txId, type: "create_table", schema });
    this.catalog.createTable(schema);
    this.heapFor(schema.name);
    this.loadOrRebuildTableIndexes(this.requireTable(schema.name));
    return emptyResult(`created table ${schema.name}`);
  }

  private createIndex(index: IndexSchema, txId: number): Omit<QueryResult, "elapsedMs"> {
    this.assertIndexCanBeBuilt(index);
    this.appendLogicalWalRecord({ txId, type: "create_index", index });
    this.catalog.createIndex(index);
    this.rebuildIndex(index.table, index.column, index);
    return emptyResult(`created index ${index.name} on ${index.table}(${index.column})`);
  }

  private insert(tableName: string, columns: string[], values: Scalar[], txId: number): Omit<QueryResult, "elapsedMs"> {
    if (columns.length !== values.length) {
      throw new Error(`INSERT expected ${columns.length} values, received ${values.length}`);
    }
    const schema = this.requireTable(tableName);
    const input: Row = {};
    for (let index = 0; index < columns.length; index += 1) {
      input[columns[index]!] = values[index] ?? null;
    }
    const row = this.normalizeRow(schema, input);
    const primaryKey = this.primaryKey(schema);
    const key = row[primaryKey.name] ?? null;
    if (key === null) throw new Error(`Primary key ${primaryKey.name} cannot be null`);
    if (this.indexFor(tableName, primaryKey.name).search(key).length > 0) {
      throw new Error(`Duplicate primary key on ${tableName}.${primaryKey.name}: ${key}`);
    }
    this.assertUniqueIndexesAvailable(tableName, row);

    this.appendLogicalWalRecord({ txId, type: "insert", table: tableName, row });
    const rowId = this.heapFor(tableName).insert(row);
    this.addRowToIndexes(tableName, row, rowId);
    this.wal.append({ txId, type: "insert_applied", table: tableName, rowId });
    return emptyResult(`inserted 1 row into ${tableName}`);
  }

  private select(
    tableName: string,
    columns: string[] | "*",
    where?: Predicate,
    orderBy?: OrderBy,
    limit?: number,
  ): Omit<QueryResult, "elapsedMs"> {
    const schema = this.requireTable(tableName);
    const selectedColumns = columns === "*" ? schema.columns.map((column) => column.name) : columns;
    this.assertColumns(schema, selectedColumns);
    if (where) this.assertColumns(schema, [where.column]);
    if (orderBy) this.assertColumns(schema, [orderBy.column]);

    const primaryKey = this.primaryKey(schema);
    const plan = planSelect(schema, primaryKey.name, this.catalog.indexesForTable(tableName), where, orderBy);
    const orderedRows = this.resolveRows(tableName, plan)
      .filter((entry) => matches(entry.row, where))
      .map((entry) => entry.row);

    if (orderBy) {
      orderedRows.sort((left, right) => {
        const compared = compareScalars(left[orderBy.column] ?? null, right[orderBy.column] ?? null);
        return orderBy.direction === "asc" ? compared : -compared;
      });
    }

    const limitedRows = limit === undefined ? orderedRows : orderedRows.slice(0, limit);
    const rows = limitedRows.map((row) => projectRow(row, selectedColumns));

    return {
      columns: selectedColumns,
      rows,
      message: `selected ${rows.length} rows via ${plan.strategy}`,
      plan,
    };
  }

  private update(
    tableName: string,
    patch: Record<string, Scalar>,
    where: Predicate | undefined,
    txId: number,
  ): Omit<QueryResult, "elapsedMs"> {
    const schema = this.requireTable(tableName);
    this.assertColumns(schema, Object.keys(patch));
    if (where) this.assertColumns(schema, [where.column]);
    const primaryKey = this.primaryKey(schema);
    const plan = planSelect(schema, primaryKey.name, this.catalog.indexesForTable(tableName), where);
    const entries = this.resolveRows(tableName, plan).filter((entry) => matches(entry.row, where));
    let updated = 0;

    for (const entry of entries) {
      const next = this.normalizeRow(schema, { ...entry.row, ...patch });
      this.assertPrimaryKeyAvailable(tableName, schema, entry.row, next);
      this.appendLogicalWalRecord({ txId, type: "update", table: tableName, before: entry.row, after: next });
      this.heapFor(tableName).delete(entry.rowId);
      this.heapFor(tableName).insert(next);
      updated += 1;
    }

    if (updated > 0) this.rebuildTableIndexes(tableName);
    return emptyResult(`updated ${updated} rows in ${tableName}`);
  }

  private delete(tableName: string, where: Predicate | undefined, txId: number): Omit<QueryResult, "elapsedMs"> {
    const schema = this.requireTable(tableName);
    if (where) this.assertColumns(schema, [where.column]);
    const primaryKey = this.primaryKey(schema);
    const plan = planSelect(schema, primaryKey.name, this.catalog.indexesForTable(tableName), where);
    const entries = this.resolveRows(tableName, plan).filter((entry) => matches(entry.row, where));
    for (const entry of entries) {
      this.appendLogicalWalRecord({ txId, type: "delete", table: tableName, rowId: entry.rowId, row: entry.row });
      this.heapFor(tableName).delete(entry.rowId);
    }
    if (entries.length > 0) this.rebuildTableIndexes(tableName);
    return emptyResult(`deleted ${entries.length} rows from ${tableName}`);
  }

  private resolveRows(tableName: string, plan: QueryPlan): HeapEntry[] {
    if (plan.strategy === "primary-key-index" || plan.strategy === "secondary-index") {
      const rowIds = this.rowIdsFromIndexedPredicate(tableName, plan);
      return this.entriesFromRowIds(tableName, rowIds);
    }

    if (plan.strategy === "index-ordered-scan" && plan.indexColumn) {
      const rowIds = this.indexFor(tableName, plan.indexColumn)
        .entries()
        .flatMap((entry) => entry.values);
      return this.entriesFromRowIds(tableName, rowIds);
    }

    return this.heapFor(tableName).scan();
  }

  private rowIdsFromIndexedPredicate(tableName: string, plan: QueryPlan): RowId[] {
    if (!plan.predicate || !plan.indexColumn) return [];
    const tree = this.indexFor(tableName, plan.indexColumn);
    const value = plan.predicate.value;

    switch (plan.predicate.op) {
      case "=":
        return tree.search(value);
      case ">":
      case ">=":
        return tree.range(value, null);
      case "<":
      case "<=":
        return tree.range(null, value);
      case "!=":
        return [];
    }
  }

  private entriesFromRowIds(tableName: string, rowIds: RowId[]): HeapEntry[] {
    return rowIds
      .map((rowId) => ({ rowId, row: this.heapFor(tableName).read(rowId) }))
      .filter((entry): entry is HeapEntry => entry.row !== null);
  }

  private rebuildTableIndexes(tableName: string): void {
    const schema = this.requireTable(tableName);
    const primaryKey = this.primaryKey(schema);
    this.rebuildIndex(tableName, primaryKey.name);
    for (const index of this.catalog.indexesForTable(tableName)) {
      this.rebuildIndex(tableName, index.column, index);
    }
  }

  private rebuildAllIndexes(): void {
    for (const table of this.catalog.listTables()) {
      this.rebuildTableIndexes(table.name);
    }
  }

  private rebuildIndex(tableName: string, column: string, schemaIndex?: IndexSchema): void {
    const tree = new BPlusTree<RowId>(32);
    const seenUniqueKeys = new Set<string>();
    for (const entry of this.heapFor(tableName).scan()) {
      const key = entry.row[column] ?? null;
      if (key === null) continue;
      if (schemaIndex?.unique) {
        const serialized = JSON.stringify(key);
        if (seenUniqueKeys.has(serialized)) {
          throw new Error(`Unique index ${schemaIndex.name} would contain duplicated key ${key}`);
        }
        seenUniqueKeys.add(serialized);
      }
      tree.insert(key, entry.rowId);
    }
    this.indexes.set(indexKey(tableName, column), tree);
    this.indexStoreFor(tableName, column).save(tableName, column, tree);
  }

  private assertPrimaryKeyAvailable(tableName: string, schema: TableSchema, before: Row, after: Row): void {
    const primaryKey = this.primaryKey(schema);
    const previousKey = before[primaryKey.name] ?? null;
    const nextKey = after[primaryKey.name] ?? null;
    if (nextKey === null) throw new Error(`Primary key ${primaryKey.name} cannot be null`);
    if (previousKey === nextKey) return;
    if (this.indexFor(tableName, primaryKey.name).search(nextKey).length > 0) {
      throw new Error(`Duplicate primary key on ${tableName}.${primaryKey.name}: ${nextKey}`);
    }
  }

  private assertUniqueIndexesAvailable(tableName: string, row: Row): void {
    for (const index of this.catalog.indexesForTable(tableName)) {
      if (!index.unique) continue;
      const key = row[index.column] ?? null;
      if (key !== null && this.indexFor(tableName, index.column).search(key).length > 0) {
        throw new Error(`Duplicate unique index key on ${index.name}: ${key}`);
      }
    }
  }

  private assertIndexCanBeBuilt(index: IndexSchema): void {
    const schema = this.requireTable(index.table);
    this.assertColumns(schema, [index.column]);
    if (!index.unique) return;

    const seen = new Set<string>();
    for (const entry of this.heapFor(index.table).scan()) {
      const key = entry.row[index.column] ?? null;
      if (key === null) continue;
      const serialized = JSON.stringify(key);
      if (seen.has(serialized)) {
        throw new Error(`Unique index ${index.name} would contain duplicated key ${key}`);
      }
      seen.add(serialized);
    }
  }

  private insertRecoveredRow(tableName: string, row: Row): boolean {
    const schema = this.requireTable(tableName);
    const normalized = this.normalizeRow(schema, row);
    const primaryKey = this.primaryKey(schema);
    const key = normalized[primaryKey.name] ?? null;
    if (key === null) throw new Error(`Primary key ${primaryKey.name} cannot be null`);
    if (this.indexFor(tableName, primaryKey.name).search(key).length > 0) return false;

    this.assertUniqueIndexesAvailable(tableName, normalized);
    const rowId = this.heapFor(tableName).insert(normalized);
    this.addRowToIndexes(tableName, normalized, rowId);
    return true;
  }

  private deleteRecoveredRow(tableName: string, row: Row): boolean {
    const schema = this.requireTable(tableName);
    const primaryKey = this.primaryKey(schema);
    const key = row[primaryKey.name] ?? null;
    if (key === null) return false;

    const rowIds = this.indexFor(tableName, primaryKey.name).search(key);
    let deleted = false;
    for (const rowId of rowIds) {
      deleted = this.heapFor(tableName).delete(rowId) || deleted;
    }
    if (deleted) this.rebuildTableIndexes(tableName);
    return deleted;
  }

  private normalizeRow(schema: TableSchema, input: Row): Row {
    const allowedColumns = new Set(schema.columns.map((column) => column.name));
    for (const column of Object.keys(input)) {
      if (!allowedColumns.has(column)) {
        throw new Error(`Unknown column ${schema.name}.${column}`);
      }
    }

    const row: Row = {};
    for (const column of schema.columns) {
      const value = input[column.name] ?? null;
      if (value === null && (column.primaryKey || column.nullable === false)) {
        throw new Error(`Column ${schema.name}.${column.name} cannot be null`);
      }
      row[column.name] = coerceValue(column, value);
    }
    return row;
  }

  private assertColumns(schema: TableSchema, columns: string[]): void {
    const allowedColumns = new Set(schema.columns.map((column) => column.name));
    for (const column of columns) {
      if (!allowedColumns.has(column)) throw new Error(`Unknown column ${schema.name}.${column}`);
    }
  }

  private primaryKey(schema: TableSchema): ColumnSchema {
    const primaryKey = schema.columns.find((column) => column.primaryKey);
    if (!primaryKey) throw new Error(`Table ${schema.name} has no primary key`);
    return primaryKey;
  }

  private requireTable(tableName: string): TableSchema {
    const schema = this.catalog.getTable(tableName);
    if (!schema) throw new Error(`Unknown table: ${tableName}`);
    return schema;
  }

  private heapFor(tableName: string): HeapFile {
    const existing = this.heaps.get(tableName);
    if (existing) return existing;
    const heap = new HeapFile(join(this.dataDir, "tables", `${tableName}.heap`));
    this.heaps.set(tableName, heap);
    return heap;
  }

  private addRowToIndexes(tableName: string, row: Row, rowId: RowId): void {
    const schema = this.requireTable(tableName);
    const primaryKey = this.primaryKey(schema);
    const primaryValue = row[primaryKey.name] ?? null;
    if (primaryValue !== null) this.indexFor(tableName, primaryKey.name).insert(primaryValue, rowId);

    for (const index of this.catalog.indexesForTable(tableName)) {
      const value = row[index.column] ?? null;
      if (value !== null) this.indexFor(tableName, index.column).insert(value, rowId);
    }
    this.persistTableIndexes(tableName);
  }

  private persistTableIndexes(tableName: string): void {
    const schema = this.requireTable(tableName);
    const primaryKey = this.primaryKey(schema);
    this.indexStoreFor(tableName, primaryKey.name).save(tableName, primaryKey.name, this.indexFor(tableName, primaryKey.name));
    for (const index of this.catalog.indexesForTable(tableName)) {
      this.indexStoreFor(tableName, index.column).save(tableName, index.column, this.indexFor(tableName, index.column));
    }
  }

  private loadOrRebuildTableIndexes(table: TableSchema): void {
    const primaryKey = this.primaryKey(table);
    this.loadOrRebuildIndex(table.name, primaryKey.name);
    for (const index of table.indexes ?? []) {
      this.loadOrRebuildIndex(table.name, index.column, index);
    }
  }

  private loadOrRebuildIndex(tableName: string, column: string, schemaIndex?: IndexSchema): void {
    const loaded = this.indexStoreFor(tableName, column).load(tableName, column);
    if (loaded) {
      this.indexes.set(indexKey(tableName, column), loaded);
      return;
    }
    this.rebuildIndex(tableName, column, schemaIndex);
  }

  private indexFor(tableName: string, column: string): BPlusTree<RowId> {
    const key = indexKey(tableName, column);
    const existing = this.indexes.get(key);
    if (existing) return existing;
    const schemaIndex = this.catalog.getIndex(tableName, column) ?? undefined;
    this.rebuildIndex(tableName, column, schemaIndex);
    const rebuilt = this.indexes.get(key);
    if (!rebuilt) throw new Error(`Could not build index for ${tableName}.${column}`);
    return rebuilt;
  }

  private indexStoreFor(tableName: string, column: string): IndexStore {
    return new IndexStore(join(this.dataDir, "indexes", `${tableName}.${column}.idx`));
  }

  private nextAutocommitTxId(): number {
    this.txCounter += 1;
    return this.txCounter;
  }

  private appendLogicalWalRecord(record: WalRecordInput): void {
    this.wal.append(record);
    this.logicalWalRecordsWritten += 1;
  }
}

function coerceValue(column: ColumnSchema, value: Scalar): Scalar {
  if (value === null) return null;
  if (column.type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`Column ${column.name} expects an integer`);
    }
    return value;
  }
  return String(value);
}

function projectRow(row: Row, columns: string[]): Row {
  const projected: Row = {};
  for (const column of columns) {
    projected[column] = row[column] ?? null;
  }
  return projected;
}

function emptyResult(message: string): Omit<QueryResult, "elapsedMs"> {
  return { columns: [], rows: [], message };
}

function indexKey(tableName: string, column: string): string {
  return `${tableName}:${column}`;
}
