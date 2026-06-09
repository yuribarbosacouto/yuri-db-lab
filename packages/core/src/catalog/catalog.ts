import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ColumnSchema, TableSchema } from "../types.js";

type CatalogDocument = {
  version: 1;
  tables: TableSchema[];
};

export class Catalog {
  private document: CatalogDocument;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.document = existsSync(filePath) ? readCatalog(filePath) : { version: 1, tables: [] };
  }

  createTable(schema: TableSchema): void {
    if (this.getTable(schema.name)) {
      throw new Error(`Table already exists: ${schema.name}`);
    }
    validateTableSchema(schema);
    this.document.tables.push(schema);
    this.save();
  }

  getTable(name: string): TableSchema | null {
    return this.document.tables.find((table) => table.name === name) ?? null;
  }

  listTables(): TableSchema[] {
    return this.document.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({ ...column })),
    }));
  }

  primaryKey(tableName: string): ColumnSchema {
    const table = this.getTable(tableName);
    if (!table) throw new Error(`Unknown table: ${tableName}`);
    const primaryKey = table.columns.find((column) => column.primaryKey);
    if (!primaryKey) throw new Error(`Table ${tableName} does not have a primary key`);
    return primaryKey;
  }

  private save(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.document, null, 2)}\n`, "utf8");
  }
}

function readCatalog(filePath: string): CatalogDocument {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tables)) {
    throw new Error("Catalog file is not a yuri-db-lab catalog");
  }
  for (const table of parsed.tables) validateTableSchema(table);
  return parsed as CatalogDocument;
}

function validateTableSchema(schema: TableSchema): void {
  if (!schema.name || !/^[a-zA-Z_]\w*$/.test(schema.name)) {
    throw new Error(`Invalid table name: ${schema.name}`);
  }
  if (!Array.isArray(schema.columns) || schema.columns.length === 0) {
    throw new Error(`Table ${schema.name} must have columns`);
  }
  const names = new Set<string>();
  let primaryKeys = 0;
  for (const column of schema.columns) {
    if (!column.name || !/^[a-zA-Z_]\w*$/.test(column.name)) {
      throw new Error(`Invalid column name: ${column.name}`);
    }
    if (names.has(column.name)) throw new Error(`Duplicated column: ${column.name}`);
    names.add(column.name);
    if (column.type !== "int" && column.type !== "text") {
      throw new Error(`Unsupported column type for ${column.name}: ${column.type}`);
    }
    if (column.primaryKey) primaryKeys += 1;
  }
  if (primaryKeys !== 1) {
    throw new Error(`Table ${schema.name} must have exactly one primary key`);
  }
}
