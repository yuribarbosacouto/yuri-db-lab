#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { YuriDatabase } from "@ydb/core";
import type { QueryResult } from "@ydb/core";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

try {
  if (command === "exec") {
    runExec(args.slice(1));
  } else if (command === "shell") {
    await runShell(args.slice(1));
  } else if (command === "recover") {
    runRecover(args.slice(1));
  } else {
    printHelp();
    process.exitCode = command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function runRecover(args: string[]): void {
  const sourceDir = readOption(args, "--from", "");
  const targetDir = readOption(args, "--to", "");
  if (!sourceDir) throw new Error("Missing --from");
  if (!targetDir) throw new Error("Missing --to");

  const report = YuriDatabase.recoverFromWal(sourceDir, targetDir);
  console.table([report]);
}

function runExec(args: string[]): void {
  const dataDir = readOption(args, "--dir", ".ydb");
  const sql = readOption(args, "--sql", "");
  if (!sql) throw new Error("Missing --sql");

  const db = new YuriDatabase(dataDir);
  for (const statement of splitSqlStatements(sql)) {
    printResult(db.execute(statement));
  }
}

async function runShell(args: string[]): Promise<void> {
  const dataDir = readOption(args, "--dir", ".ydb");
  const db = new YuriDatabase(dataDir);
  const rl = createInterface({ input, output });
  console.log(`yuri-db-lab shell using ${dataDir}. Type .quit to exit.`);

  while (true) {
    const line = (await rl.question("ydb> ")).trim();
    if (!line) continue;
    if (line === ".quit" || line === ".exit") break;
    if (line === ".tables") {
      console.table(db.listTables().map((table) => ({ table: table.name, columns: table.columns.length })));
      continue;
    }

    try {
      for (const statement of splitSqlStatements(line)) {
        printResult(db.execute(statement));
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }

  rl.close();
}

function readOption(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
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

function printResult(result: QueryResult): void {
  if (result.rows.length > 0) {
    console.table(result.rows);
  }
  if (result.plan) {
    console.log(`plan: ${result.plan.strategy} (${result.plan.reason})`);
  }
  console.log(`${result.message} (${result.elapsedMs} ms)`);
}

function printHelp(): void {
  console.log(`yuri-db-lab

Usage:
  ydb exec --dir .ydb --sql "create table users (id int primary key, name text);"
  ydb shell --dir .ydb
  ydb recover --from .ydb --to .ydb-recovered

Shell commands:
  .tables   list catalog tables
  .quit     exit
`);
}
