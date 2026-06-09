# SQL Dialect

Yuri DB Lab supports a deliberately small SQL subset.

## Types

```sql
int
text
```

Every table must declare exactly one primary key.

## Create table

```sql
create table users (
  id int primary key,
  name text not null,
  age int
);
```

## Insert

```sql
insert into users (id, name, age) values (1, 'Yuri', 23);
```

## Select

```sql
select * from users;
select id, name from users where id = 1;
select * from users where age >= 18;
```

Supported predicate operators:

```text
= != > >= < <=
```

Primary-key equality predicates use the B+Tree index. Other predicates use heap scan.

## Update

```sql
update users set name = 'Barbosa' where id = 1;
```

## Delete

```sql
delete from users where id = 1;
```

## Transactions

```sql
begin;
insert into users (id, name) values (2, 'Ana');
commit;
```

Writes are queued during a transaction. `commit` applies queued writes. `rollback` discards them.

## Not supported yet

- Joins
- Aggregation
- Ordering
- Secondary indexes
- Foreign keys
- Multi-statement isolation
