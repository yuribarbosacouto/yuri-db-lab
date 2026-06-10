import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YuriDatabase } from "../src/database/database.js";
import { HeapFile } from "../src/storage/heap-file.js";
import { IndexStore } from "../src/storage/index-store.js";
import { WriteAheadLog } from "../src/wal/wal.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ydb-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("YuriDatabase", () => {
  it("creates a table, persists rows, and selects through the primary-key index", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text not null, age int)");
    db.execute("insert into users (id, name, age) values (1, 'Yuri', 23)");
    db.execute("insert into users (id, name, age) values (2, 'Ana', 29)");

    const result = db.execute("select id, name from users where id = 2");

    expect(result.plan?.strategy).toBe("primary-key-index");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([{ id: 2, name: "Ana" }]);

    const reopened = new YuriDatabase(dir);
    expect(reopened.execute("select * from users where id = 1").rows).toEqual([{ id: 1, name: "Yuri", age: 23 }]);
  });

  it("rejects duplicate primary keys", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");
    db.execute("insert into users (id, name) values (1, 'Yuri')");

    expect(() => db.execute("insert into users (id, name) values (1, 'Duplicated')")).toThrow(/Duplicate primary key/);
  });

  it("updates, deletes, and rebuilds the index", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");
    db.execute("insert into users (id, name) values (1, 'Yuri')");
    db.execute("update users set name = 'Barbosa' where id = 1");

    expect(db.execute("select * from users where id = 1").rows).toEqual([{ id: 1, name: "Barbosa" }]);

    db.execute("delete from users where id = 1");
    expect(db.execute("select * from users where id = 1").rows).toEqual([]);
  });

  it("queues and rolls back writes inside a transaction", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");
    db.execute("begin");
    db.execute("insert into users (id, name) values (1, 'Yuri')");
    db.execute("rollback");

    expect(db.execute("select * from users").rows).toEqual([]);
  });

  it("commits queued transaction writes", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");
    db.execute("begin");
    db.execute("insert into users (id, name) values (1, 'Yuri')");
    db.execute("commit");

    expect(db.execute("select * from users").rows).toEqual([{ id: 1, name: "Yuri" }]);
  });

  it("creates secondary indexes and chooses them in the query plan", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text, age int)");
    db.execute("insert into users (id, name, age) values (1, 'Yuri', 23)");
    db.execute("insert into users (id, name, age) values (2, 'Ana', 29)");
    db.execute("insert into users (id, name, age) values (3, 'Lia', 29)");
    db.execute("create index idx_users_age on users (age)");

    const result = db.execute("select id, age from users where age = 29 order by id desc limit 1");

    expect(result.plan?.strategy).toBe("secondary-index");
    expect(result.rows).toEqual([{ id: 3, age: 29 }]);
    expect(existsSync(join(dir, "indexes", "users.age.idx"))).toBe(true);
    expect(existsSync(join(dir, "indexes", "users.age.idx.checksums.json"))).toBe(true);

    db.execute("insert into users (id, name, age) values (4, 'Bia', 31)");
    const indexStore = new IndexStore(join(dir, "indexes", "users.age.idx"));
    const pageCountBeforeReopen = indexStore.inspect("users", "age").pageCount;

    const reopened = new YuriDatabase(dir);
    expect(reopened.execute("select id from users where age = 23").plan?.strategy).toBe("secondary-index");
    expect(reopened.execute("select id from users where age = 31").rows).toEqual([{ id: 4 }]);
    expect(indexStore.inspect("users", "age").pageCount).toBe(pageCountBeforeReopen);
  });

  it("answers indexed queries from page-backed indexes without loading the full tree", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text, age int)");
    for (let id = 1; id <= 120; id += 1) {
      db.execute(`insert into users (id, name, age) values (${id}, 'user-${id}', ${20 + (id % 12)})`);
    }
    db.execute("create index idx_users_age on users (age)");

    const originalLoad = IndexStore.prototype.load;
    IndexStore.prototype.load = function loadShouldNotRun() {
      throw new Error("IndexStore.load should not be called for direct paged queries");
    };

    try {
      const reopened = new YuriDatabase(dir);
      const filtered = reopened.execute("select id, age from users where age = 24 order by id limit 3");
      const ordered = reopened.execute("select id, age from users order by age limit 3");

      expect(filtered.plan?.strategy).toBe("secondary-index");
      expect(filtered.rows).toEqual([
        { id: 4, age: 24 },
        { id: 16, age: 24 },
        { id: 28, age: 24 },
      ]);
      expect(ordered.plan?.strategy).toBe("index-ordered-scan");
      expect(ordered.rows).toEqual([
        { id: 12, age: 20 },
        { id: 24, age: 20 },
        { id: 36, age: 20 },
      ]);
    } finally {
      IndexStore.prototype.load = originalLoad;
    }
  });

  it("rejects unique secondary indexes with duplicated keys", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, email text)");
    db.execute("insert into users (id, email) values (1, 'a@example.test')");
    db.execute("insert into users (id, email) values (2, 'a@example.test')");

    expect(() => db.execute("create unique index idx_users_email on users (email)")).toThrow(/duplicated key/);
  });

  it("recovers committed data from the write-ahead log into a new directory", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text, age int)");
    db.execute("create index idx_users_age on users (age)");
    db.execute("insert into users (id, name, age) values (1, 'Yuri', 23)");
    db.execute("begin");
    db.execute("insert into users (id, name, age) values (2, 'Ana', 29)");
    db.execute("commit");
    db.execute("begin");
    db.execute("insert into users (id, name, age) values (3, 'Rolled', 40)");
    db.execute("rollback");

    const recoveredDir = `${dir}-recovered`;
    const report = YuriDatabase.recoverFromWal(dir, recoveredDir);
    const recovered = new YuriDatabase(recoveredDir);

    expect(report.transactionsCommitted).toBe(1);
    expect(report.transactionsRolledBack).toBe(1);
    expect(recovered.execute("select id from users where age = 29").rows).toEqual([{ id: 2 }]);
    expect(recovered.execute("select * from users where id = 3").rows).toEqual([]);

    rmSync(recoveredDir, { recursive: true, force: true });
  });

  it("replays committed autocommit WAL records when opening the database", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");

    const wal = new WriteAheadLog(join(dir, "wal.jsonl"));
    wal.append({ txId: 1001, type: "insert", table: "users", row: { id: 2, name: "Recovered" } });

    const reopened = new YuriDatabase(dir);

    expect(reopened.startupRecovery()?.recordsApplied).toBeGreaterThanOrEqual(1);
    expect(reopened.execute("select * from users where id = 2").rows).toEqual([{ id: 2, name: "Recovered" }]);
  });

  it("replays committed transaction batches when opening the database", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");

    const wal = new WriteAheadLog(join(dir, "wal.jsonl"));
    wal.append({ txId: 2001, type: "begin" });
    wal.append({ txId: 2001, type: "insert", table: "users", row: { id: 3, name: "Committed" } });
    wal.append({ txId: 2001, type: "commit" });

    const reopened = new YuriDatabase(dir);

    expect(reopened.startupRecovery()?.transactionsCommitted).toBeGreaterThanOrEqual(1);
    expect(reopened.execute("select * from users where id = 3").rows).toEqual([{ id: 3, name: "Committed" }]);
  });

  it("undoes heap changes from incomplete transaction batches when opening the database", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");

    const row = { id: 4, name: "Uncommitted" };
    const wal = new WriteAheadLog(join(dir, "wal.jsonl"));
    wal.append({ txId: 3001, type: "begin" });
    wal.append({ txId: 3001, type: "insert", table: "users", row });
    new HeapFile(join(dir, "tables", "users.heap")).insert(row);

    const reopened = new YuriDatabase(dir);

    expect(reopened.startupRecovery()?.incompleteTransactionsDiscarded).toBe(1);
    expect(reopened.startupRecovery()?.recordsUndone).toBe(1);
    expect(reopened.execute("select * from users where id = 4").rows).toEqual([]);
  });

  it("rejects transaction batches with invalid commit markers on startup", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");

    const wal = new WriteAheadLog(join(dir, "wal.jsonl"));
    wal.append({ txId: 4001, type: "begin" });
    wal.append({ txId: 4001, type: "insert", table: "users", row: { id: 5, name: "Invalid" } });
    wal.append({ txId: 4001, type: "commit", recordCount: 2 });

    const reopened = new YuriDatabase(dir);

    expect(reopened.startupRecovery()?.invalidCommitMarkers).toBe(1);
    expect(reopened.execute("select * from users where id = 5").rows).toEqual([]);
  });

  it("rejects transaction batches with invalid commit markers during manual WAL recovery", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");

    const wal = new WriteAheadLog(join(dir, "wal.jsonl"));
    wal.append({ txId: 5001, type: "begin" });
    wal.append({ txId: 5001, type: "insert", table: "users", row: { id: 6, name: "Invalid" } });
    wal.append({ txId: 5001, type: "commit", recordCount: 2 });

    const recoveredDir = `${dir}-manual-recovered`;
    const report = YuriDatabase.recoverFromWal(dir, recoveredDir);
    const recovered = new YuriDatabase(recoveredDir);

    expect(report.invalidCommitMarkers).toBe(1);
    expect(recovered.execute("select * from users where id = 6").rows).toEqual([]);

    rmSync(recoveredDir, { recursive: true, force: true });
  });

  it("writes commit markers with the number of logical WAL records", () => {
    const db = new YuriDatabase(dir);
    db.execute("create table users (id int primary key, name text)");
    db.execute("begin");
    db.execute("insert into users (id, name) values (6, 'Counted')");
    db.execute("commit");

    const commits = new WriteAheadLog(join(dir, "wal.jsonl")).readAll().filter((record) => record.type === "commit");

    expect(commits.at(-1)).toMatchObject({ type: "commit", recordCount: 1 });
  });
});
