type QueryPlan = {
  strategy: string;
  reason: string;
  estimatedCost: number;
  indexName?: string;
  indexColumn?: string;
};

type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  message: string;
  elapsedMs: number;
  plan?: QueryPlan;
};

type WorkbenchSnapshot = {
  dataDir: string;
  startupRecovery: unknown;
  files: Array<{ path: string; bytes: number }>;
  wal: Array<Record<string, unknown>>;
  heapPages: Array<{ table: string; pageId: number; rows: number; samples: unknown[]; error?: string }>;
  indexPages: Array<{
    table: string;
    column: string;
    file: string;
    info: { format: string; pageCount: number; rootPageId?: number; firstLeafPageId?: number };
    pages: Array<{ pageId: number; kind?: string; keys?: unknown[]; children?: number[]; entries?: unknown[]; nextPageId?: number | null; error?: string }>;
  }>;
};

type ExecuteResponse = {
  results: QueryResult[];
  snapshot: WorkbenchSnapshot;
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

type GuidedDemoResponse = ExecuteResponse & {
  evidence: DemoEvidence[];
  trace: TraceStep[];
  recovery: {
    report: Record<string, unknown> | null;
    beforeRows: Record<string, unknown>[];
    afterRows: Record<string, unknown>[];
  };
};

const sqlInput = document.querySelector<HTMLTextAreaElement>("#sql-input")!;
const guidedBtn = document.querySelector<HTMLButtonElement>("#guided-btn")!;
const runBtn = document.querySelector<HTMLButtonElement>("#run-btn")!;
const seedBtn = document.querySelector<HTMLButtonElement>("#seed-btn")!;
const resetBtn = document.querySelector<HTMLButtonElement>("#reset-btn")!;
const dbDir = document.querySelector<HTMLElement>("#db-dir")!;
const dbStatus = document.querySelector<HTMLElement>("#db-status")!;
const demoEl = document.querySelector<HTMLElement>("#demo")!;
const resultsEl = document.querySelector<HTMLElement>("#results")!;
const plansEl = document.querySelector<HTMLElement>("#plans")!;
const filesEl = document.querySelector<HTMLElement>("#files")!;
const walEl = document.querySelector<HTMLElement>("#wal")!;
const indexesEl = document.querySelector<HTMLElement>("#indexes")!;
const heapEl = document.querySelector<HTMLElement>("#heap")!;

sqlInput.value = [
  "select id, name, age from users where age = 24 order by id limit 5;",
  "insert into users (id, name, age) values (999, 'Workbench', 24);",
  "select id, name, age from users where age = 24 order by id desc limit 5;",
].join("\n");

guidedBtn.addEventListener("click", () => runGuidedDemo());
runBtn.addEventListener("click", () => runSql());
seedBtn.addEventListener("click", () => seedDemo());
resetBtn.addEventListener("click", () => resetDb());

void refresh();

async function refresh(): Promise<void> {
  setBusy("loading");
  try {
    const snapshot = await requestJson<WorkbenchSnapshot>("/api/snapshot");
    renderSnapshot(snapshot);
    renderResults([]);
    renderDemo();
    setBusy("ready");
  } catch (error) {
    renderError(resultsEl, error);
    setBusy("error");
  }
}

async function runGuidedDemo(): Promise<void> {
  setBusy("demo");
  try {
    const response = await requestJson<GuidedDemoResponse>("/api/demo/guided", { method: "POST" });
    renderResults(response.results);
    renderSnapshot(response.snapshot);
    renderDemo(response.evidence, response.trace, response.recovery);
    sqlInput.value = [
      "select id, name, age from users where age = 24 order by id limit 8;",
      "select id, name, age from users where age = 24 order by id desc limit 5;",
    ].join("\n");
    setBusy("ready");
  } catch (error) {
    renderError(demoEl, error);
    setBusy("error");
  }
}

async function runSql(): Promise<void> {
  setBusy("running");
  try {
    const response = await requestJson<ExecuteResponse>("/api/execute", {
      method: "POST",
      body: JSON.stringify({ sql: sqlInput.value }),
      headers: { "content-type": "application/json" },
    });
    renderResults(response.results);
    renderSnapshot(response.snapshot);
    setBusy("ready");
  } catch (error) {
    renderError(resultsEl, error);
    setBusy("error");
  }
}

async function seedDemo(): Promise<void> {
  setBusy("seeding");
  try {
    const response = await requestJson<ExecuteResponse>("/api/seed", { method: "POST" });
    renderResults(response.results);
    renderSnapshot(response.snapshot);
    renderDemo();
    setBusy("ready");
  } catch (error) {
    renderError(resultsEl, error);
    setBusy("error");
  }
}

async function resetDb(): Promise<void> {
  setBusy("resetting");
  try {
    const snapshot = await requestJson<WorkbenchSnapshot>("/api/reset", { method: "POST" });
    renderResults([]);
    renderSnapshot(snapshot);
    renderDemo();
    setBusy("ready");
  } catch (error) {
    renderError(resultsEl, error);
    setBusy("error");
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(parsed?.error ?? `Request failed with ${response.status}`);
  }
  return parsed as T;
}

function renderSnapshot(snapshot: WorkbenchSnapshot): void {
  dbDir.textContent = snapshot.dataDir;
  filesEl.replaceChildren(...snapshot.files.map(renderFile));
  walEl.replaceChildren(...snapshot.wal.map(renderWalRecord));
  indexesEl.replaceChildren(...snapshot.indexPages.map(renderIndex));
  heapEl.replaceChildren(...snapshot.heapPages.map(renderHeap));

  if (snapshot.files.length === 0) filesEl.append(empty("No storage files yet."));
  if (snapshot.wal.length === 0) walEl.append(empty("No WAL records yet."));
  if (snapshot.indexPages.length === 0) indexesEl.append(empty("No index pages yet."));
  if (snapshot.heapPages.length === 0) heapEl.append(empty("No heap pages yet."));
}

function renderDemo(evidence: DemoEvidence[] = [], trace: TraceStep[] = [], recovery?: GuidedDemoResponse["recovery"]): void {
  demoEl.replaceChildren();

  if (evidence.length === 0) {
    demoEl.append(empty("No guided evidence yet."));
    return;
  }

  for (const item of evidence) {
    const node = document.createElement("article");
    node.className = "demo-card";

    const label = document.createElement("div");
    label.append(badge(item.label));

    const body = document.createElement("div");
    const value = document.createElement("strong");
    value.className = "demo-value";
    value.textContent = item.value;
    const detail = document.createElement("p");
    detail.className = "demo-detail";
    detail.textContent = item.detail;
    body.append(value, detail);
    node.append(label, body);
    demoEl.append(node);
  }

  if (trace.length > 0) {
    const traceCard = document.createElement("article");
    traceCard.className = "trace-card";
    traceCard.append(badge("btree trace"));
    for (const step of trace) {
      const line = document.createElement("div");
      line.className = "trace-line";
      line.append(badge(`page ${step.pageId}`), document.createTextNode(`${step.kind} ${step.decision}`));
      if (step.keys.length > 0) line.append(document.createTextNode(`keys ${step.keys.map(formatValue).join(", ")}`));
      traceCard.append(line);
    }
    demoEl.append(traceCard);
  }

  if (recovery) {
    const recoveryCard = document.createElement("article");
    recoveryCard.className = "trace-card";
    recoveryCard.append(badge("recovery report"));
    recoveryCard.append(
      metaLine([
        `before ${recovery.beforeRows.length} rows`,
        `after ${recovery.afterRows.length} rows`,
        `undone ${String(recovery.report?.recordsUndone ?? 0)}`,
        `discarded ${String(recovery.report?.incompleteTransactionsDiscarded ?? 0)}`,
      ]),
      jsonBlock(recovery.report),
    );
    demoEl.append(recoveryCard);
  }
}

function renderResults(results: QueryResult[]): void {
  resultsEl.replaceChildren();
  plansEl.replaceChildren();

  if (results.length === 0) {
    resultsEl.append(empty("Run SQL or seed the demo database."));
    plansEl.append(empty("Query plans appear after SELECT statements."));
    return;
  }

  for (const result of results) {
    const block = document.createElement("div");
    const message = document.createElement("p");
    message.className = "message";
    message.textContent = `${result.message} (${result.elapsedMs} ms)`;
    block.append(message);

    if (result.rows.length > 0) {
      block.append(renderTable(result.columns, result.rows));
    }
    resultsEl.append(block);

    if (result.plan) {
      plansEl.append(renderPlan(result.plan));
    }
  }

  if (plansEl.childElementCount === 0) {
    plansEl.append(empty("No SELECT plan returned."));
  }
}

function renderTable(columns: string[], rows: Record<string, unknown>[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const column of columns) header.append(cell("th", column));
  thead.append(header);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) tr.append(cell("td", formatValue(row[column])));
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderPlan(plan: QueryPlan): HTMLElement {
  const node = document.createElement("article");
  node.className = "plan-card";
  node.append(badge(plan.strategy));
  const reason = document.createElement("p");
  reason.className = "message";
  reason.textContent = plan.reason;
  node.append(reason, metaLine([`cost ${plan.estimatedCost}`, plan.indexColumn ? `column ${plan.indexColumn}` : "no index column"]));
  return node;
}

function renderFile(file: { path: string; bytes: number }): HTMLElement {
  const row = document.createElement("div");
  row.className = "file-row";
  const path = document.createElement("span");
  path.className = "file-path";
  path.textContent = file.path;
  const size = document.createElement("span");
  size.className = "file-size";
  size.textContent = `${file.bytes} B`;
  row.append(path, size);
  return row;
}

function renderWalRecord(record: Record<string, unknown>): HTMLElement {
  const row = document.createElement("article");
  row.className = "wal-row";
  const title = document.createElement("strong");
  title.textContent = `${record.type ?? "record"} tx:${record.txId ?? "-"}`;
  row.append(title, metaLine([String(record.at ?? ""), record.table ? `table ${record.table}` : ""]));
  row.append(jsonBlock(record));
  return row;
}

function renderIndex(index: WorkbenchSnapshot["indexPages"][number]): HTMLElement {
  const node = document.createElement("article");
  node.className = "index-card";
  node.append(badge(`${index.table}.${index.column}`));
  node.append(metaLine([index.info.format, `${index.info.pageCount} pages`, `root ${index.info.rootPageId ?? "-"}`, `first leaf ${index.info.firstLeafPageId ?? "-"}`]));
  for (const page of index.pages) {
    const line = document.createElement("div");
    line.className = "page-line";
    line.append(badge(`page ${page.pageId}`), document.createTextNode(page.error ?? `${page.kind ?? "unknown"} keys:${page.keys?.length ?? 0} entries:${page.entries?.length ?? 0}`));
    node.append(line);
  }
  return node;
}

function renderHeap(page: WorkbenchSnapshot["heapPages"][number]): HTMLElement {
  const node = document.createElement("article");
  node.className = "heap-card";
  node.append(badge(`${page.table} page ${page.pageId}`));
  node.append(metaLine([`${page.rows} rows`, page.error ?? "checksum ok"]));
  if (page.samples.length > 0) node.append(jsonBlock(page.samples));
  return node;
}

function cell(tag: "td" | "th", value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function badge(text: string): HTMLElement {
  const node = document.createElement("span");
  node.className = "badge";
  node.textContent = text;
  return node;
}

function metaLine(values: string[]): HTMLElement {
  const line = document.createElement("div");
  line.className = "meta-line";
  for (const value of values.filter(Boolean)) {
    const span = document.createElement("span");
    span.textContent = value;
    line.append(span);
  }
  return line;
}

function jsonBlock(value: unknown): HTMLElement {
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

function empty(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function renderError(target: HTMLElement, error: unknown): void {
  target.replaceChildren();
  const node = document.createElement("div");
  node.className = "error";
  node.textContent = error instanceof Error ? error.message : String(error);
  target.append(node);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function setBusy(text: string): void {
  dbStatus.textContent = text;
}
