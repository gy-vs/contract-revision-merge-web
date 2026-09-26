/**
 * Three-way merge core shared by the server (conflict detection on conditional
 * updates) and the client (auto-merge + manual resolution UI).
 *
 * Semantics:
 * - Plain objects are merged recursively, field by field.
 * - Arrays and primitives are atomic values: any difference (including array
 *   reordering) is a change at the array's own path.
 * - A local and a remote change conflict when their paths overlap (equal, or
 *   one is an ancestor of the other) and the two sides do not converge to the
 *   same value at the common ancestor path. This covers deletions and
 *   parent/child edits at the same path, not just top-level keys.
 */

export type Path = (string | number)[];

/** Sentinel for "no value at this path" (deleted, or never existed). */
export const MISSING: unique symbol = Symbol('merge.missing');

export interface Conflict {
  path: Path;
  /** Value at `path` in each version; MISSING when that side has no value. */
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface MergeResult {
  /** remote + every non-conflicting local change applied. */
  merged: unknown;
  conflicts: Conflict[];
}

/** JSON-safe shape of a Conflict; absent values are omitted keys. */
export interface WireConflict {
  path: Path;
  base?: unknown;
  local?: unknown;
  remote?: unknown;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === MISSING || b === MISSING) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const av = key in a ? a[key] : MISSING;
      const bv = key in b ? b[key] : MISSING;
      if (!deepEqual(av, bv)) return false;
    }
    return true;
  }
  return false;
}

export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function getAtPath(doc: unknown, path: Path): unknown {
  let node = doc;
  for (const key of path) {
    if (!isPlainObject(node) && !Array.isArray(node)) return MISSING;
    node = (node as Record<string | number, unknown>)[key];
    if (node === undefined) return MISSING;
  }
  return node;
}

/**
 * Sets (or deletes, when value is MISSING) `path` inside `doc`, in place.
 * Parent nodes must already exist — guaranteed for non-conflicting changes,
 * since a changed or removed ancestor would itself be a conflict.
 */
export function setAtPath(doc: unknown, path: Path, value: unknown): void {
  if (path.length === 0) throw new Error('cannot replace the root via setAtPath');
  let node = doc as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (value === MISSING) delete node[last];
  else node[last] = value;
}

/** Paths where `next` differs from `base`. Arrays/primitives compare atomically. */
export function changedPaths(base: unknown, next: unknown, path: Path = []): Path[] {
  if (deepEqual(base, next)) return [];
  if (isPlainObject(base) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
    const paths: Path[] = [];
    for (const key of keys) {
      const baseValue = key in base ? base[key] : MISSING;
      const nextValue = key in next ? next[key] : MISSING;
      paths.push(...changedPaths(baseValue, nextValue, [...path, key]));
    }
    return paths;
  }
  return [path];
}

function isPrefix(prefix: Path, path: Path): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => key === path[index]);
}

function pathsEqual(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

export function threeWayMerge(base: unknown, local: unknown, remote: unknown): MergeResult {
  const localChanges = changedPaths(base, local);
  const remoteChanges = changedPaths(base, remote);

  const conflictPaths: Path[] = [];
  for (const localPath of localChanges) {
    for (const remotePath of remoteChanges) {
      if (!isPrefix(localPath, remotePath) && !isPrefix(remotePath, localPath)) continue;
      const ancestor = localPath.length <= remotePath.length ? localPath : remotePath;
      // Both sides converged to the same value at the ancestor: not a conflict.
      if (deepEqual(getAtPath(local, ancestor), getAtPath(remote, ancestor))) continue;
      if (!conflictPaths.some(path => pathsEqual(path, ancestor))) conflictPaths.push(ancestor);
    }
  }

  const conflicts: Conflict[] = conflictPaths.map(path => ({
    path,
    base: getAtPath(base, path),
    local: getAtPath(local, path),
    remote: getAtPath(remote, path),
  }));

  let merged = clone(remote);
  for (const localPath of localChanges) {
    if (conflictPaths.some(conflictPath => isPrefix(conflictPath, localPath))) continue;
    const value = getAtPath(local, localPath);
    // Identical change on both sides: the remote copy is already correct.
    if (deepEqual(value, getAtPath(remote, localPath))) continue;
    if (localPath.length === 0) {
      merged = clone(local);
      continue;
    }
    setAtPath(merged, localPath, value);
  }
  return {merged, conflicts};
}

/** Applies a user's per-conflict choice on top of the auto-merged document. */
export function applyResolution(merged: unknown, conflict: Conflict, choice: 'local' | 'remote'): unknown {
  const value = choice === 'local' ? conflict.local : conflict.remote;
  if (conflict.path.length === 0) return value === MISSING ? null : clone(value);
  const next = clone(merged);
  setAtPath(next, conflict.path, value);
  return next;
}

export function formatPath(path: Path): string {
  return path.reduce<string>(
    (acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : `${acc}.${key}`),
    '$',
  );
}

/** Stable key for a path, usable as a map key in resolution state. */
export function pathKey(path: Path): string {
  return JSON.stringify(path);
}

export function serializeConflict(conflict: Conflict): WireConflict {
  const wire: WireConflict = {path: conflict.path};
  if (conflict.base !== MISSING) wire.base = conflict.base;
  if (conflict.local !== MISSING) wire.local = conflict.local;
  if (conflict.remote !== MISSING) wire.remote = conflict.remote;
  return wire;
}

export function deserializeConflict(wire: WireConflict): Conflict {
  return {
    path: wire.path,
    base: 'base' in wire ? wire.base : MISSING,
    local: 'local' in wire ? wire.local : MISSING,
    remote: 'remote' in wire ? wire.remote : MISSING,
  };
}
