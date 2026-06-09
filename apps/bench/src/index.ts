import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { YuriDatabase } from "@ydb/core";

const rows = Number(readOption(process.argv.slice(2), "--rows", "2000"));
if (!Number.isInteger(rows) || rows <= 0) {
  throw new Error("--rows must be a positive integer");
}

const dir = mkdtempSync(join(tmpdir(), "ydb-bench-"));

try {
  const db = new YuriDatabase(dir);
  db.execute("create table users (id int primary key, name text not null, age int)");

  const insertMs = timed(() => {
    for (let id = 1; id <= rows; id += 1) {
      db.execute(`insert into users (id, name, age) values (${id}, 'user-${id}', ${20 + (id % 50)})`);
    }
  });

  const pointReadMs = timed(() => {
    for (let id = 1; id <= Math.min(rows, 500); id += 1) {
      db.execute(`select * from users where id = ${id}`);
    }
  });

  db.execute("create index idx_users_age on users (age)");
  const secondaryIndexMs = timed(() => {
    for (let age = 20; age < 45; age += 1) {
      db.execute(`select id, age from users where age = ${age} order by age limit 20`);
    }
  });

  const heapScanMs = timed(() => {
    db.execute("select * from users where age >= 40");
  });

  console.table([
    { operation: "insert", rows, ms: insertMs, rowsPerSecond: Math.round((rows / insertMs) * 1000) },
    { operation: "primary-key point reads", rows: Math.min(rows, 500), ms: pointReadMs, rowsPerSecond: Math.round((Math.min(rows, 500) / pointReadMs) * 1000) },
    { operation: "secondary-index reads", rows: 25, ms: secondaryIndexMs, rowsPerSecond: Math.round((25 / secondaryIndexMs) * 1000) },
    { operation: "heap predicate scan", rows, ms: heapScanMs, rowsPerSecond: Math.round((rows / heapScanMs) * 1000) },
  ]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function timed(fn: () => void): number {
  const started = performance.now();
  fn();
  return Number((performance.now() - started).toFixed(3));
}

function readOption(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}
