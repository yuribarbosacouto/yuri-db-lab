import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BPlusTree } from "../btree/btree.js";
import { Catalog } from "../catalog/catalog.js";
import { matches } from "../sql/evaluator.js";
import { parseSql } from "../sql/parser.js";
import type {
  ColumnSchema,
  QueryResult,
  Row,
  RowId,
  Scalar,
  Statement,
  TableSchema,
} from "../types.js";
import { HeapFile } from "../storage/heap-file.js";
import type { HeapEntry } from "../storage/heap-file.js";
import { WriteAheadLog } from "../wal/wal.js";

type ActiveTransaction = {
  txId: number;
  statements: Statement[];
};

type IndexMap = Map<string, BPlusTree<RowId>>;

export class YuriDatabase {
  private readonly catalog: Catalog;
  private readonly wal: WriteAheadLog;
  private readonly heaps = new Map<string, HeapFile>();
  private readonly indexes: IndexMap = new Map();
  private activeTransaction: ActiveTransaction | null = null;
  private txCounter = Date.now();

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "tables"), { recursive: true });
    this.catalog = new Catalog(join(dataDir, "catalog.json"));
    this.wal = new WriteAheadLog(join(dataDir, "wal.jsonl"));
    for (const table of this.catalog.listTables()) {
      this.heapFor(table.name);
      this.rebuildIndex(table.name);
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

  private executeStatement(statement: Statement): Omit<QueryResult, "elapsedMs"> {
    if (statement.kind === "begin") return this.begin();
    if (statement.kind === "commit") return this.commit();
    if (statement.kind === "rollback") return this.rollback();

    if (this.activeTransaction && statement.kind !== "select") {
      if (statement.kind === "create_table") {
        throw new Error("CREATE TABLE is intentionally kept outside transactions in this lab");
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
    for (const statement of transaction.statements) {
      this.applyStatement(statement, transaction.txId);
    }
    this.wal.append({ txId: transaction.txId, type: "commit" });
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

  private applyStatement(statement: Statement, txId: number): Omit<QueryResult, "elapsedMs"> {
    switch (statement.kind) {
      case "create_table":
        return this.createTable(statement.table, txId);
      case "insert":
        return this.insert(statement.table, statement.columns, statement.values, txId);
      case "select":
        return this.select(statement.table, statement.columns, statement.where);
      case "update":
        return this.update(statement.table, statement.set, statement.where, txId);
      case "delete":
        return this.delete(statement.table, statement.where, txId);
      default:
        throw new Error(`Unsupported statement in apply phase: ${statement.kind}`);
    }
  }

  private createTable(schema: TableSchema, txId: number): Omit<QueryResult, "elapsedMs"> {
    this.wal.append({ txId, type: "create_table", schema });
    this.catalog.createTable(schema);
    this.heapFor(schema.name);
    this.rebuildIndex(schema.name);
    return emptyResult(`created table ${schema.name}`);
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
    if (this.indexFor(tableName).search(key).length > 0) {
      throw new Error(`Duplicate primary key on ${tableName}.${primaryKey.name}: ${key}`);
    }

    this.wal.append({ txId, type: "insert", table: tableName, row });
    const rowId = this.heapFor(tableName).insert(row);
    this.indexFor(tableName).insert(key, rowId);
    this.wal.append({ txId, type: "insert_applied", table: tableName, rowId });
    return emptyResult(`inserted 1 row into ${tableName}`);
  }

  private select(tableName: string, columns: string[] | "*", where?: StatementWhere): Omit<QueryResult, "elapsedMs"> {
    const schema = this.requireTable(tableName);
    const selectedColumns = columns === "*" ? schema.columns.map((column) => column.name) : columns;
    this.assertColumns(schema, selectedColumns);

    const rows = this.resolveRows(tableName, schema, where)
      .filter((entry) => matches(entry.row, where))
      .map((entry) => projectRow(entry.row, selectedColumns));

    const strategy = where && where.column === this.primaryKey(schema).name && where.op === "=" ? "primary-key index" : "heap scan";
    return {
      columns: selectedColumns,
      rows,
      message: `selected ${rows.length} rows via ${strategy}`,
    };
  }

  private update(
    tableName: string,
    patch: Record<string, Scalar>,
    where: StatementWhere | undefined,
    txId: number,
  ): Omit<QueryResult, "elapsedMs"> {
    const schema = this.requireTable(tableName);
    this.assertColumns(schema, Object.keys(patch));
    const entries = this.resolveRows(tableName, schema, where).filter((entry) => matches(entry.row, where));
    let updated = 0;

    for (const entry of entries) {
      const next = this.normalizeRow(schema, { ...entry.row, ...patch });
      this.assertPrimaryKeyAvailable(tableName, schema, entry.row, next);
      this.wal.append({ txId, type: "update", table: tableName, before: entry.row, after: next });
      this.heapFor(tableName).delete(entry.rowId);
      this.heapFor(tableName).insert(next);
      updated += 1;
    }

    if (updated > 0) this.rebuildIndex(tableName);
    return emptyResult(`updated ${updated} rows in ${tableName}`);
  }

  private delete(tableName: string, where: StatementWhere | undefined, txId: number): Omit<QueryResult, "elapsedMs"> {
    const schema = this.requireTable(tableName);
    const entries = this.resolveRows(tableName, schema, where).filter((entry) => matches(entry.row, where));
    for (const entry of entries) {
      this.wal.append({ txId, type: "delete", table: tableName, rowId: entry.rowId, row: entry.row });
      this.heapFor(tableName).delete(entry.rowId);
    }
    if (entries.length > 0) this.rebuildIndex(tableName);
    return emptyResult(`deleted ${entries.length} rows from ${tableName}`);
  }

  private resolveRows(tableName: string, schema: TableSchema, where?: StatementWhere): HeapEntry[] {
    const primaryKey = this.primaryKey(schema);
    if (where && where.column === primaryKey.name && where.op === "=") {
      return this.indexFor(tableName)
        .search(where.value)
        .map((rowId) => ({ rowId, row: this.heapFor(tableName).read(rowId) }))
        .filter((entry): entry is HeapEntry => entry.row !== null);
    }
    return this.heapFor(tableName).scan();
  }

  private rebuildIndex(tableName: string): void {
    const schema = this.requireTable(tableName);
    const primaryKey = this.primaryKey(schema);
    const index = new BPlusTree<RowId>(32);
    for (const entry of this.heapFor(tableName).scan()) {
      const key = entry.row[primaryKey.name] ?? null;
      if (key !== null) index.insert(key, entry.rowId);
    }
    this.indexes.set(tableName, index);
  }

  private assertPrimaryKeyAvailable(tableName: string, schema: TableSchema, before: Row, after: Row): void {
    const primaryKey = this.primaryKey(schema);
    const previousKey = before[primaryKey.name] ?? null;
    const nextKey = after[primaryKey.name] ?? null;
    if (nextKey === null) throw new Error(`Primary key ${primaryKey.name} cannot be null`);
    if (previousKey === nextKey) return;
    if (this.indexFor(tableName).search(nextKey).length > 0) {
      throw new Error(`Duplicate primary key on ${tableName}.${primaryKey.name}: ${nextKey}`);
    }
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

  private indexFor(tableName: string): BPlusTree<RowId> {
    const existing = this.indexes.get(tableName);
    if (existing) return existing;
    this.rebuildIndex(tableName);
    const rebuilt = this.indexes.get(tableName);
    if (!rebuilt) throw new Error(`Could not build index for ${tableName}`);
    return rebuilt;
  }

  private nextAutocommitTxId(): number {
    this.txCounter += 1;
    return this.txCounter;
  }
}

type StatementWhere = Extract<Statement, { kind: "select" }>["where"];

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
