import type {
  ColumnSchema,
  Predicate,
  PredicateOp,
  Scalar,
  Statement,
  TableSchema,
} from "../types.js";

const predicatePattern = /^([a-zA-Z_][\w]*)\s*(=|!=|>=|<=|>|<)\s*(.+)$/i;

export function parseSql(input: string): Statement {
  const sql = input.trim().replace(/;$/, "").trim();
  if (!sql) {
    throw new Error("SQL statement is empty");
  }

  if (/^begin$/i.test(sql)) return { kind: "begin" };
  if (/^commit$/i.test(sql)) return { kind: "commit" };
  if (/^rollback$/i.test(sql)) return { kind: "rollback" };

  const create = sql.match(/^create\s+table\s+([a-zA-Z_][\w]*)\s*\((.+)\)$/i);
  if (create) {
    return { kind: "create_table", table: parseTableSchema(create[1]!, create[2]!) };
  }

  const insert = sql.match(/^insert\s+into\s+([a-zA-Z_][\w]*)\s*\((.+)\)\s+values\s*\((.+)\)$/i);
  if (insert) {
    return {
      kind: "insert",
      table: insert[1]!,
      columns: splitComma(insert[2]!).map((item) => item.trim()),
      values: splitComma(insert[3]!).map(parseValue),
    };
  }

  const select = sql.match(/^select\s+(.+)\s+from\s+([a-zA-Z_][\w]*)(?:\s+where\s+(.+))?$/i);
  if (select) {
    const columns = select[1]!.trim() === "*" ? "*" : splitComma(select[1]!).map((item) => item.trim());
    return {
      kind: "select",
      table: select[2]!,
      columns,
      ...(select[3] ? { where: parsePredicate(select[3]) } : {}),
    };
  }

  const update = sql.match(/^update\s+([a-zA-Z_][\w]*)\s+set\s+(.+?)(?:\s+where\s+(.+))?$/i);
  if (update) {
    const set: Record<string, Scalar> = {};
    for (const part of splitComma(update[2]!)) {
      const assignment = part.match(/^([a-zA-Z_][\w]*)\s*=\s*(.+)$/);
      if (!assignment) throw new Error(`Invalid assignment: ${part}`);
      set[assignment[1]!] = parseValue(assignment[2]!);
    }
    return {
      kind: "update",
      table: update[1]!,
      set,
      ...(update[3] ? { where: parsePredicate(update[3]) } : {}),
    };
  }

  const del = sql.match(/^delete\s+from\s+([a-zA-Z_][\w]*)(?:\s+where\s+(.+))?$/i);
  if (del) {
    return {
      kind: "delete",
      table: del[1]!,
      ...(del[2] ? { where: parsePredicate(del[2]) } : {}),
    };
  }

  throw new Error(`Unsupported SQL: ${input}`);
}

function parseTableSchema(name: string, body: string): TableSchema {
  const columns: ColumnSchema[] = splitComma(body).map((definition) => {
    const parts = definition.trim().split(/\s+/);
    const columnName = parts[0];
    const type = parts[1]?.toLowerCase();
    if (!columnName || (type !== "int" && type !== "text")) {
      throw new Error(`Invalid column definition: ${definition}`);
    }
    return {
      name: columnName,
      type,
      primaryKey: /primary\s+key/i.test(definition),
      nullable: !/not\s+null/i.test(definition),
    };
  });

  if (!columns.some((column) => column.primaryKey)) {
    throw new Error("A table must declare one primary key");
  }

  return { name, columns };
}

export function parsePredicate(input: string): Predicate {
  const match = input.trim().match(predicatePattern);
  if (!match) throw new Error(`Invalid predicate: ${input}`);
  return {
    column: match[1]!,
    op: match[2]! as PredicateOp,
    value: parseValue(match[3]!),
  };
}

export function parseValue(input: string): Scalar {
  const value = input.trim();
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  const quoted = value.match(/^'(.*)'$/s) ?? value.match(/^"(.*)"$/s);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  return value;
}

export function splitComma(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of input) {
    if ((char === "'" || char === '"') && quote === null) quote = char;
    else if (char === quote) quote = null;

    if (char === "," && quote === null) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
