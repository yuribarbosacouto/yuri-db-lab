import type { IndexSchema, OrderBy, Predicate, QueryPlan, TableSchema } from "../types.js";

export function planSelect(
  table: TableSchema,
  primaryKeyColumn: string,
  indexes: IndexSchema[],
  where?: Predicate,
  orderBy?: OrderBy,
): QueryPlan {
  if (where?.column === primaryKeyColumn && where.op === "=") {
    return {
      strategy: "primary-key-index",
      table: table.name,
      indexName: `${table.name}_primary_key`,
      indexColumn: primaryKeyColumn,
      predicate: where,
      ...(orderBy ? { orderBy } : {}),
      estimatedCost: 1,
      reason: "Primary-key equality can be answered with a point lookup.",
    };
  }

  const predicateIndex = where ? indexes.find((index) => index.column === where.column) : undefined;
  if (where && predicateIndex && where.op !== "!=") {
    return {
      strategy: "secondary-index",
      table: table.name,
      indexName: predicateIndex.name,
      indexColumn: predicateIndex.column,
      predicate: where,
      ...(orderBy ? { orderBy } : {}),
      estimatedCost: 8,
      reason: `Predicate column ${where.column} has a secondary index.`,
    };
  }

  const orderIndex = orderBy ? indexes.find((index) => index.column === orderBy.column) : undefined;
  if (!where && orderBy && orderIndex) {
    return {
      strategy: "index-ordered-scan",
      table: table.name,
      indexName: orderIndex.name,
      indexColumn: orderIndex.column,
      orderBy,
      estimatedCost: 16,
      reason: `ORDER BY ${orderBy.column} can stream through a secondary index.`,
    };
  }

  return {
    strategy: "heap-scan",
    table: table.name,
    ...(where ? { predicate: where } : {}),
    ...(orderBy ? { orderBy } : {}),
    estimatedCost: 100,
    reason: "No usable index matched the query shape.",
  };
}
