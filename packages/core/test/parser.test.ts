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
});
