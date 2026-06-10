import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HeapFile, IndexStore, PageFile, WriteAheadLog, YuriDatabase } from "@ydb/core";
import type { QueryResult, Row, Scalar, TableSchema } from "@ydb/core";

type WorkbenchSnapshot = {
  dataDir: string;
  startupRecovery: unknown;
  files: Array<{ path: string; bytes: number }>;
  wal: Array<Record<string, unknown>>;
  heapPages: Array<{ table: string; pageId: number; rows: number; samples: Row[]; error?: string }>;
  indexPages: Array<{
    table: string;
    column: string;
    file: string;
    info: ReturnType<IndexStore["inspect"]>;
    pages: Array<{ pageId: number; kind?: string; keys?: unknown[]; children?: number[]; entries?: unknown[]; nextPageId?: number | null; error?: string }>;
  }>;
};

type DemoEvidence = {
  label: string;
  value: string;
  detail: string;
};

type TraceStep = {
  pageId: number;
  kind: string;
  keys: unknown[];
  decision: string;
};

type RecoveryDemo = {
  report: ReturnType<YuriDatabase["startupRecovery"]>;
  beforeRows: Row[];
  afterRows: Row[];
};

const publicDir = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const clientPath = resolve(fileURLToPath(new URL("client.js", import.meta.url)));
const args = process.argv.slice(2);
const port = Number(readOption(args, "--port", process.env.PORT ?? "4177"));
const dataDir = resolve(readOption(args, "--dir", join(process.cwd(), ".workbench-db")));
let db = openDatabase();

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => sendJson(request, response, 500, { error: messageFrom(error) }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Yuri DB Lab Workbench`);
  console.log(`URL: http://127.0.0.1:${port}`);
  console.log(`Data: ${dataDir}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const readMethod = method === "GET" || method === "HEAD";

  if (readMethod && url.pathname === "/") return sendFile(request, response, join(publicDir, "index.html"), "text/html; charset=utf-8");
  if (readMethod && url.pathname === "/styles.css") return sendFile(request, response, join(publicDir, "styles.css"), "text/css; charset=utf-8");
  if (readMethod && url.pathname === "/client.js") return sendFile(request, response, clientPath, "text/javascript; charset=utf-8");
  if (readMethod && url.pathname === "/api/snapshot") return sendJson(request, response, 200, snapshot());
  if (method === "POST" && url.pathname === "/api/execute") return executeSql(request, response);
  if (method === "POST" && url.pathname === "/api/demo/guided") return guidedDemo(response);
  if (method === "POST" && url.pathname === "/api/seed") return seedDemo(response);
  if (method === "POST" && url.pathname === "/api/reset") return resetDatabase(response);

  sendJson(request, response, 404, { error: "Not found" });
}

async function executeSql(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson<{ sql?: string }>(request);
  const sql = body.sql?.trim();
  if (!sql) return sendJson(request, response, 400, { error: "Missing SQL" });

  const results = executeStatements(sql);
  sendJson(request, response, 200, { results, snapshot: snapshot() });
}

function seedDemo(response: ServerResponse): void {
  resetDataDir();
  db = openDatabase();
  const statements = [
    "create table users (id int primary key, name text not null, age int)",
    "create index idx_users_age on users (age)",
    ...Array.from({ length: 72 }, (_, index) => {
      const id = index + 1;
      const age = 20 + (id % 18);
      return `insert into users (id, name, age) values (${id}, 'user-${id}', ${age})`;
    }),
    "select id, name, age from users where age = 24 order by id limit 8",
  ];
  const results = executeStatements(statements.join(";"));
  sendJson(undefined, response, 200, { results, snapshot: snapshot() });
}

function guidedDemo(response: ServerResponse): void {
  resetDataDir();
  db = openDatabase();

  const results: QueryResult[] = [];
  results.push(db.execute("create table users (id int primary key, name text not null, age int)"));
  for (const statement of demoUserInserts(180)) results.push(db.execute(statement));

  const heapScan = db.execute("select id, name, age from users where age = 24 order by id limit 8");
  results.push(heapScan);
  results.push(db.execute("create index idx_users_age on users (age)"));
  const indexedLookup = db.execute("select id, name, age from users where age = 24 order by id limit 8");
  results.push(indexedLookup);
  const orderedScan = db.execute("select id, age from users order by age limit 8");
  results.push(orderedScan);
  results.push(db.execute("insert into users (id, name, age) values (999, 'Workbench', 24)"));
  const postInsertLookup = db.execute("select id, name, age from users where age = 24 order by id desc limit 5");
  results.push(postInsertLookup);

  const currentSnapshot = snapshot();
  const recovery = runRecoveryDemo();
  const evidence = guidedEvidence(heapScan, indexedLookup, orderedScan, postInsertLookup, currentSnapshot, recovery);
  const trace = traceIndexPath(currentSnapshot, "users", "age", 24);

  sendJson(undefined, response, 200, {
    results: [heapScan, indexedLookup, orderedScan, postInsertLookup],
    snapshot: currentSnapshot,
    evidence,
    trace,
    recovery,
  });
}

function resetDatabase(response: ServerResponse): void {
  resetDataDir();
  db = openDatabase();
  sendJson(undefined, response, 200, snapshot());
}

function snapshot(): WorkbenchSnapshot {
  const tables = db.listTables();
  return {
    dataDir,
    startupRecovery: db.startupRecovery(),
    files: listFiles(dataDir),
    wal: walRecords(),
    heapPages: heapPages(tables),
    indexPages: indexPages(tables),
  };
}

function executeStatements(sql: string): QueryResult[] {
  const results: QueryResult[] = [];
  for (const statement of splitSqlStatements(sql)) {
    results.push(db.execute(statement));
  }
  return results;
}

function demoUserInserts(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    const age = 20 + (id % 18);
    return `insert into users (id, name, age) values (${id}, 'user-${id}', ${age})`;
  });
}

function guidedEvidence(
  heapScan: QueryResult,
  indexedLookup: QueryResult,
  orderedScan: QueryResult,
  postInsertLookup: QueryResult,
  currentSnapshot: WorkbenchSnapshot,
  recovery: RecoveryDemo,
): DemoEvidence[] {
  const ageIndex = currentSnapshot.indexPages.find((index) => index.table === "users" && index.column === "age");
  const heapRows = currentSnapshot.heapPages.reduce((total, page) => total + page.rows, 0);
  const walRecordCount = currentSnapshot.wal.length;

  return [
    {
      label: "query planner",
      value: `${heapScan.plan?.strategy ?? "-"} -> ${indexedLookup.plan?.strategy ?? "-"}`,
      detail: `Same predicate, same rows, different physical path. Estimated cost changed from ${heapScan.plan?.estimatedCost ?? "-"} to ${indexedLookup.plan?.estimatedCost ?? "-"}.`,
    },
    {
      label: "ordered scan",
      value: orderedScan.plan?.strategy ?? "-",
      detail: `ORDER BY age can use the secondary index after idx_users_age exists.`,
    },
    {
      label: "mutable index",
      value: `${postInsertLookup.rows[0]?.id ?? "-"} returned after insert`,
      detail: `The row inserted after index creation is visible through the secondary index without rebuilding the whole database.`,
    },
    {
      label: "storage files",
      value: `${heapRows} heap rows, ${ageIndex?.info.pageCount ?? 0} age-index pages`,
      detail: `The demo produced heap pages, checksum manifests, WAL records, and page-backed B+Tree files on disk.`,
    },
    {
      label: "wal volume",
      value: `${walRecordCount} records`,
      detail: `Every schema and row mutation left an append-only recovery trail in wal.jsonl.`,
    },
    {
      label: "crash recovery",
      value: `${recovery.beforeRows.length} dirty rows -> ${recovery.afterRows.length} recovered rows`,
      detail: `Startup recovery discarded ${String(recovery.report?.incompleteTransactionsDiscarded ?? 0)} incomplete transaction and undid ${String(recovery.report?.recordsUndone ?? 0)} heap record.`,
    },
  ];
}

function runRecoveryDemo(): RecoveryDemo {
  const recoveryDir = `${dataDir}-crash-demo`;
  resetWorkDir(recoveryDir);

  let crashDb = new YuriDatabase(recoveryDir);
  crashDb.execute("create table users (id int primary key, name text not null)");
  crashDb.execute("insert into users (id, name) values (1, 'Committed')");

  const uncommitted: Row = { id: 2, name: "Uncommitted" };
  const wal = new WriteAheadLog(join(recoveryDir, "wal.jsonl"));
  wal.append({ txId: 8001, type: "begin" });
  wal.append({ txId: 8001, type: "insert", table: "users", row: uncommitted });
  new HeapFile(join(recoveryDir, "tables", "users.heap")).insert(uncommitted);

  crashDb = new YuriDatabase(recoveryDir, { recoverOnOpen: false });
  const beforeRows = crashDb.execute("select * from users order by id").rows;
  const recovered = new YuriDatabase(recoveryDir);
  const report = recovered.startupRecovery();
  const afterRows = recovered.execute("select * from users order by id").rows;

  return { report, beforeRows, afterRows };
}

function traceIndexPath(snapshot: WorkbenchSnapshot, table: string, column: string, key: Scalar): TraceStep[] {
  const index = snapshot.indexPages.find((candidate) => candidate.table === table && candidate.column === column);
  if (!index || index.info.rootPageId === undefined) return [];

  const pages = new Map(index.pages.map((page) => [page.pageId, page]));
  const trace: TraceStep[] = [];
  let pageId: number | undefined = index.info.rootPageId;
  const visited = new Set<number>();

  while (pageId !== undefined && !visited.has(pageId)) {
    visited.add(pageId);
    const page = pages.get(pageId);
    if (!page) break;

    const keys = page.keys ?? entriesToKeys(page.entries);
    if (page.kind !== "internal") {
      trace.push({ pageId, kind: page.kind ?? "unknown", keys, decision: `contains key ${String(key)} candidates` });
      break;
    }

    const childIndex = findChildIndex(keys, key);
    const nextPageId = page.children?.[childIndex];
    const decision = nextPageId === undefined ? "has no child for this key" : `key ${String(key)} follows child ${nextPageId}`;
    trace.push({ pageId, kind: page.kind, keys, decision });
    pageId = nextPageId;
  }

  return trace;
}

function entriesToKeys(entries: unknown[] | undefined): unknown[] {
  if (!entries) return [];
  return entries.map((entry) => (isRecord(entry) ? entry.key : undefined)).filter((value) => value !== undefined);
}

function findChildIndex(keys: unknown[], key: Scalar): number {
  let index = 0;
  while (index < keys.length && compareScalarLike(key, keys[index]) >= 0) index += 1;
  return index;
}

function compareScalarLike(left: Scalar, right: unknown): number {
  if (right === null || typeof right === "string" || typeof right === "number") {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return left < right ? -1 : 1;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function heapPages(tables: TableSchema[]): WorkbenchSnapshot["heapPages"] {
  const pages: WorkbenchSnapshot["heapPages"] = [];
  for (const table of tables) {
    const filePath = join(dataDir, "tables", `${table.name}.heap`);
    if (!existsSync(filePath)) continue;
    const pageFile = new PageFile(filePath);
    for (let pageId = 0; pageId < pageFile.pageCount(); pageId += 1) {
      try {
        const page = pageFile.readPage(pageId);
        const entries = page.scan().map((entry) => decodeRow(entry.payload));
        pages.push({ table: table.name, pageId, rows: entries.length, samples: entries.slice(0, 5) });
      } catch (error) {
        pages.push({ table: table.name, pageId, rows: 0, samples: [], error: messageFrom(error) });
      }
    }
  }
  return pages;
}

function indexPages(tables: TableSchema[]): WorkbenchSnapshot["indexPages"] {
  const output: WorkbenchSnapshot["indexPages"] = [];
  for (const table of tables) {
    const columns = [primaryKey(table), ...(table.indexes ?? []).map((index) => index.column)];
    for (const column of columns) {
      const filePath = join(dataDir, "indexes", `${table.name}.${column}.idx`);
      if (!existsSync(filePath)) continue;
      const store = new IndexStore(filePath);
      const info = store.inspect(table.name, column);
      const pageFile = new PageFile(filePath);
      const pages: WorkbenchSnapshot["indexPages"][number]["pages"] = [];
      for (let pageId = 0; pageId < pageFile.pageCount(); pageId += 1) {
        try {
          const page = readIndexPage(pageFile, pageId);
          const rendered: WorkbenchSnapshot["indexPages"][number]["pages"][number] = { pageId };
          if (typeof page.kind === "string") rendered.kind = page.kind;
          if (Array.isArray(page.keys)) rendered.keys = page.keys;
          if (Array.isArray(page.children)) rendered.children = page.children.filter((value): value is number => typeof value === "number");
          if (Array.isArray(page.entries)) rendered.entries = page.entries.slice(0, 8);
          if (typeof page.nextPageId === "number" || page.nextPageId === null) rendered.nextPageId = page.nextPageId;
          pages.push(rendered);
        } catch (error) {
          pages.push({ pageId, error: messageFrom(error) });
        }
      }
      output.push({ table: table.name, column, file: relative(dataDir, filePath), info, pages });
    }
  }
  return output;
}

function readIndexPage(pageFile: PageFile, pageId: number): Record<string, unknown> {
  const page = pageFile.readPage(pageId);
  const entries = page.scan();
  if (entries.length !== 1) throw new Error(`Index page ${pageId} expected exactly one payload`);
  return JSON.parse(entries[0]!.payload.toString("utf8")) as Record<string, unknown>;
}

function walRecords(): Array<Record<string, unknown>> {
  const walPath = join(dataDir, "wal.jsonl");
  if (!existsSync(walPath)) return [];
  return new WriteAheadLog(walPath).readAll() as unknown as Array<Record<string, unknown>>;
}

function listFiles(root: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(root)) return [];
  const files: Array<{ path: string; bytes: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSyncSafe(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) stack.push(path);
      else files.push({ path: relative(root, path), bytes: stat.size });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function resetDataDir(): void {
  resetWorkDir(dataDir);
}

function resetWorkDir(targetDir: string): void {
  if (!basename(targetDir).includes("workbench")) {
    throw new Error(`Refusing to reset non-workbench directory: ${targetDir}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
}

function openDatabase(): YuriDatabase {
  mkdirSync(dataDir, { recursive: true });
  return new YuriDatabase(dataDir);
}

function decodeRow(payload: Buffer): Row {
  return JSON.parse(payload.toString("utf8")) as Row;
}

function primaryKey(table: TableSchema): string {
  const column = table.columns.find((candidate) => candidate.primaryKey);
  if (!column) throw new Error(`Table ${table.name} has no primary key`);
  return column.name;
}

function splitSqlStatements(inputSql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of inputSql) {
    if ((char === "'" || char === '"') && quote === null) quote = char;
    else if (char === quote) quote = null;

    if (char === ";" && quote === null) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function sendFile(request: IncomingMessage, response: ServerResponse, path: string, contentType: string): void {
  if (!existsSync(path)) return sendJson(request, response, 404, { error: "File not found" });
  response.writeHead(200, { "content-type": contentType });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(readFileSync(path));
}

function sendJson(request: IncomingMessage | undefined, response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  if (request?.method === "HEAD") {
    response.end();
    return;
  }
  response.end(JSON.stringify(value));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function readOption(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
