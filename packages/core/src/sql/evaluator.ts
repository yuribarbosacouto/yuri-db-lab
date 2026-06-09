import type { Predicate, Row, Scalar } from "../types.js";

export function matches(row: Row, predicate?: Predicate): boolean {
  if (!predicate) return true;
  const left = row[predicate.column];
  const right = predicate.value;
  const comparison = compareScalars(left ?? null, right);

  switch (predicate.op) {
    case "=":
      return comparison === 0;
    case "!=":
      return comparison !== 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
  }
}

export function compareScalars(left: Scalar, right: Scalar): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}
