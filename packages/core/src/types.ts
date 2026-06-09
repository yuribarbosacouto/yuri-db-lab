export type Scalar = string | number | null;

export type ColumnType = "int" | "text";

export type ColumnSchema = {
  name: string;
  type: ColumnType;
  primaryKey?: boolean;
  nullable?: boolean;
};

export type TableSchema = {
  name: string;
  columns: ColumnSchema[];
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

export type CreateTableStatement = {
  kind: "create_table";
  table: TableSchema;
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
};
