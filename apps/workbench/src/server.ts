import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IndexStore, PageFile, WriteAheadLog, YuriDatabase } from "@ydb/core";
import type { QueryResult, Row, TableSchema } from "@ydb/core";

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
  if (!basename(dataDir).includes("workbench")) {
    throw new Error(`Refusing to reset non-workbench directory: ${dataDir}`);
  }
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
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
