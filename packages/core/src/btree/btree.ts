import type { RowId, Scalar } from "../types.js";
import { compareScalars } from "../sql/evaluator.js";

type LeafNode<V> = {
  kind: "leaf";
  keys: Scalar[];
  values: V[][];
  next: LeafNode<V> | null;
};

type InternalNode<V> = {
  kind: "internal";
  keys: Scalar[];
  children: BTreeNode<V>[];
};

type BTreeNode<V> = LeafNode<V> | InternalNode<V>;

type Split<V> = {
  key: Scalar;
  right: BTreeNode<V>;
};

export class BPlusTree<V = RowId> {
  private root: BTreeNode<V>;

  constructor(private readonly order = 16) {
    if (order < 4) throw new Error("B+Tree order must be at least 4");
    this.root = { kind: "leaf", keys: [], values: [], next: null };
  }

  insert(key: Scalar, value: V): void {
    if (key === null) throw new Error("B+Tree keys cannot be null");
    const split = this.insertInto(this.root, key, value);
    if (split) {
      this.root = {
        kind: "internal",
        keys: [split.key],
        children: [this.root, split.right],
      };
    }
  }

  search(key: Scalar): V[] {
    if (key === null) return [];
    const leaf = this.findLeaf(key);
    const index = leaf.keys.findIndex((candidate) => compareScalars(candidate, key) === 0);
    return index >= 0 ? [...leaf.values[index]!] : [];
  }

  range(min: Scalar | null, max: Scalar | null): V[] {
    const output: V[] = [];
    let leaf: LeafNode<V> | null = this.leftmostLeaf();
    while (leaf) {
      for (let index = 0; index < leaf.keys.length; index += 1) {
        const key = leaf.keys[index]!;
        if ((min === null || compareScalars(key, min) >= 0) && (max === null || compareScalars(key, max) <= 0)) {
          output.push(...leaf.values[index]!);
        }
      }
      leaf = leaf.next;
    }
    return output;
  }

  entries(): Array<{ key: Scalar; values: V[] }> {
    const output: Array<{ key: Scalar; values: V[] }> = [];
    let leaf: LeafNode<V> | null = this.leftmostLeaf();
    while (leaf) {
      for (let index = 0; index < leaf.keys.length; index += 1) {
        output.push({ key: leaf.keys[index]!, values: [...leaf.values[index]!] });
      }
      leaf = leaf.next;
    }
    return output;
  }

  private insertInto(node: BTreeNode<V>, key: Scalar, value: V): Split<V> | null {
    if (node.kind === "leaf") {
      const index = findInsertIndex(node.keys, key);
      if (index < node.keys.length && compareScalars(node.keys[index]!, key) === 0) {
        node.values[index]!.push(value);
      } else {
        node.keys.splice(index, 0, key);
        node.values.splice(index, 0, [value]);
      }
      return node.keys.length > this.order ? this.splitLeaf(node) : null;
    }

    const childIndex = findChildIndex(node.keys, key);
    const child = node.children[childIndex];
    if (!child) throw new Error("B+Tree internal node points to a missing child");

    const split = this.insertInto(child, key, value);
    if (!split) return null;

    node.keys.splice(childIndex, 0, split.key);
    node.children.splice(childIndex + 1, 0, split.right);
    return node.keys.length > this.order ? this.splitInternal(node) : null;
  }

  private splitLeaf(node: LeafNode<V>): Split<V> {
    const midpoint = Math.ceil(node.keys.length / 2);
    const right: LeafNode<V> = {
      kind: "leaf",
      keys: node.keys.splice(midpoint),
      values: node.values.splice(midpoint),
      next: node.next,
    };
    node.next = right;
    const promoted = right.keys[0];
    if (promoted === undefined) throw new Error("Cannot split an empty B+Tree leaf");
    return { key: promoted, right };
  }

  private splitInternal(node: InternalNode<V>): Split<V> {
    const midpoint = Math.floor(node.keys.length / 2);
    const promoted = node.keys[midpoint];
    if (promoted === undefined) throw new Error("Cannot split an empty B+Tree internal node");

    const right: InternalNode<V> = {
      kind: "internal",
      keys: node.keys.splice(midpoint + 1),
      children: node.children.splice(midpoint + 1),
    };
    node.keys.splice(midpoint, 1);
    return { key: promoted, right };
  }

  private findLeaf(key: Scalar): LeafNode<V> {
    let node = this.root;
    while (node.kind === "internal") {
      const child = node.children[findChildIndex(node.keys, key)];
      if (!child) throw new Error("B+Tree internal node points to a missing child");
      node = child;
    }
    return node;
  }

  private leftmostLeaf(): LeafNode<V> {
    let node = this.root;
    while (node.kind === "internal") {
      const child = node.children[0];
      if (!child) throw new Error("B+Tree internal node has no leftmost child");
      node = child;
    }
    return node;
  }
}

function findInsertIndex(keys: Scalar[], key: Scalar): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (compareScalars(keys[mid]!, key) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findChildIndex(keys: Scalar[], key: Scalar): number {
  let index = 0;
  while (index < keys.length && compareScalars(key, keys[index]!) >= 0) {
    index += 1;
  }
  return index;
}
