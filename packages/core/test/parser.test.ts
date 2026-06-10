import { describe, expect, it } from "vitest";
import { parseSql } from "../src/sql/parser.js";

describe("parseSql", () => {
  it("parses create table statements with primary keys", () => {
    expect(parseSql("create table users (id int primary key, name text not null);")).toEqual({
      kind: "create_table",
      table: {
        name: "users",
        columns: [
          { name: "id", type: "int", primaryKey: true, nullable: true },
          { name: "name", type: "text", primaryKey: false, nullable: false },
        ],
      },
    });
  });

  it("parses quoted values without splitting inside strings", () => {
    expect(parseSql("insert into users (id, name) values (1, 'Yuri, Barbosa')")).toEqual({
      kind: "insert",
      table: "users",
      columns: ["id", "name"],
      values: [1, "Yuri, Barbosa"],
    });
  });

  it("parses indexed select predicates", () => {
    expect(parseSql("select id, name from users where id = 42")).toEqual({
      kind: "select",
      table: "users",
      columns: ["id", "name"],
      where: { column: "id", op: "=", value: 42 },
    });
  });

  it("parses create index statements", () => {
    expect(parseSql("create unique index idx_users_email on users (email)")).toEqual({
      kind: "create_index",
      index: { name: "idx_users_email", table: "users", column: "email", unique: true },
    });
  });

  it("parses order by and limit clauses", () => {
    expect(parseSql("select id from users where age >= 18 order by age desc limit 3")).toEqual({
      kind: "select",
      table: "users",
      columns: ["id"],
      where: { column: "age", op: ">=", value: 18 },
      orderBy: { column: "age", direction: "desc" },
      limit: 3,
    });
  });

  it("parses order by and limit without a where clause", () => {
    expect(parseSql("select id, age from users order by age limit 8")).toEqual({
      kind: "select",
      table: "users",
      columns: ["id", "age"],
      orderBy: { column: "age", direction: "asc" },
      limit: 8,
    });
  });
});
