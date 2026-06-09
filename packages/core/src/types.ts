export type Scalar = string | number | null;

export type ColumnType = "int" | "text";

export type ColumnSchema = {
  name: string;
  type: ColumnType;
  primaryKey?: boolean;
  nullable?: boolean;
};

export type IndexSchema = {
  name: string;
  table: string;
  column: string;
  unique?: boolean;
};

export type TableSchema = {
  name: string;
  columns: ColumnSchema[];
  indexes?: IndexSchema[];
};

export type Row = Record<string, Scalar>;

export type RowId = {
  pageId: number;
  slotId: number;
};

export type PredicateOp = "=" | "!=" | ">" | ">=" | "<" | "<=";

export type Predicate = {
  column: string;
  op: PredicateOp;
  value: Scalar;
};

export type SortDirection = "asc" | "desc";

export type OrderBy = {
  column: string;
  direction: SortDirection;
};

export type CreateTableStatement = {
  kind: "create_table";
  table: TableSchema;
};

export type CreateIndexStatement = {
  kind: "create_index";
  index: IndexSchema;
};

export type InsertStatement = {
  kind: "insert";
  table: string;
  columns: string[];
  values: Scalar[];
};

export type SelectStatement = {
  kind: "select";
  table: string;
  columns: string[] | "*";
  where?: Predicate;
  orderBy?: OrderBy;
  limit?: number;
};

export type UpdateStatement = {
  kind: "update";
  table: string;
  set: Record<string, Scalar>;
  where?: Predicate;
};

export type DeleteStatement = {
  kind: "delete";
  table: string;
  where?: Predicate;
};

export type TxStatement = {
  kind: "begin" | "commit" | "rollback";
};

export type Statement =
  | CreateTableStatement
  | CreateIndexStatement
  | InsertStatement
  | SelectStatement
  | UpdateStatement
  | DeleteStatement
  | TxStatement;

export type QueryResult = {
  columns: string[];
  rows: Row[];
  message: string;
  elapsedMs: number;
  plan?: QueryPlan;
};

export type QueryPlan = {
  strategy: "primary-key-index" | "secondary-index" | "index-ordered-scan" | "heap-scan";
  table: string;
  indexName?: string;
  indexColumn?: string;
  predicate?: Predicate;
  orderBy?: OrderBy;
  estimatedCost: number;
  reason: string;
};

export type RecoveryReport = {
  sourceDir: string;
  targetDir: string;
  recordsRead: number;
  recordsApplied: number;
  transactionsCommitted: number;
  transactionsRolledBack: number;
};

export type StartupRecoveryReport = {
  dataDir: string;
  recordsRead: number;
  recordsApplied: number;
  recordsUndone: number;
  transactionsCommitted: number;
  transactionsRolledBack: number;
  incompleteTransactionsDiscarded: number;
};
