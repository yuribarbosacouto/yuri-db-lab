import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YuriDatabase } from "../src/database/database.js";

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

    expect(result.message).toContain("primary-key index");
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
});
