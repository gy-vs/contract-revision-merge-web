// Shared deep three-way merge used by both the server (conflict responses)
// and the client (draft re-confirmation after reload and conflict UI).

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type Path = (string | number)[];
export type ConflictKind = 'value' | 'array-order';

export interface Conflict {
  path: Path;
  kind: ConflictKind;
  base: Json | undefined;
  local: Json | undefined;
  remote: Json | undefined;
  basePresent: boolean;
  localPresent: boolean;
  remotePresent: boolean;
}

interface Outcome {
  present: boolean;
  value: Json | undefined;
  conflicts: Conflict[];
}

const ELEM = 'elem';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b) || b === null) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every(k => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function present(value: Json | undefined): Outcome {
  return {present: value !== undefined, value, conflicts: []};
}

function valueConflict(path: Path, o: Json | undefined, a: Json | undefined, b: Json | undefined): Outcome {
  const aPresent = a !== undefined;
  const bPresent = b !== undefined;
  return {
    present: true,
    // Placeholder until the user picks a side: prefer the remote value,
    // otherwise the surviving local value (e.g. local edit vs remote delete).
    value: bPresent ? b : a,
    conflicts: [{
      path: path.slice(),
      kind: 'value',
      base: o,
      local: a,
      remote: b,
      basePresent: o !== undefined,
      localPresent: aPresent,
      remotePresent: bPresent,
    }],
  };
}

function mergeObject(path: Path, o: Record<string, Json> | undefined, a: Record<string, Json>, b: Record<string, Json>): Outcome {
  const keys = new Set<string>([
    ...(o ? Object.keys(o) : []),
    ...Object.keys(a),
    ...Object.keys(b),
  ]);
  const value: Record<string, Json> = {};
  const conflicts: Conflict[] = [];
  for (const key of keys) {
    const child = mergeNode(
      [...path, key],
      o && Object.hasOwn(o, key) ? o[key] : undefined,
      Object.hasOwn(a, key) ? a[key] : undefined,
      Object.hasOwn(b, key) ? b[key] : undefined,
    );
    if (child.present && child.value !== undefined) value[key] = child.value;
    conflicts.push(...child.conflicts);
  }
  return {present: true, value, conflicts};
}

// --- Array support: element identity + diff3-style sequence alignment -------

function elementKey(value: Json): string {
  if (isPlainObject(value)) {
    for (const field of ['id', 'key', 'name']) {
      if (Object.hasOwn(value, field)) {
        const v = value[field];
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
          return `${field}=${JSON.stringify(v)}`;
        }
      }
    }
  }
  // Primitives (including plain enum strings) compare by value, so equal
  // values across sides describe the same element.
  if (value === null || typeof value !== 'object') {
    return `v=${JSON.stringify(value)}`;
  }
  return '~' + JSON.stringify(value);
}

interface Tokenized {
  tokens: string[];
  at: Map<string, Json>;
}

function tokenize(arr: Json[]): Tokenized {
  const seen = new Map<string, number>();
  const tokens: string[] = [];
  const at = new Map<string, Json>();
  for (const v of arr) {
    const baseKey = elementKey(v);
    const occurrence = seen.get(baseKey) ?? 0;
    seen.set(baseKey, occurrence + 1);
    const token = `${baseKey}#${occurrence}`;
    tokens.push(token);
    at.set(token, v);
  }
  return {tokens, at};
}

function isReordered(baseTokens: string[], sideTokens: string[], survives: (t: string) => boolean): boolean {
  const common = new Set(baseTokens.filter(t => sideTokens.includes(t) && survives(t)));
  return JSON.stringify(baseTokens.filter(t => common.has(t)))
    !== JSON.stringify(sideTokens.filter(t => common.has(t)));
}

function mergeArray(path: Path, o: Json[] | undefined, a: Json[], b: Json[]): Outcome {
  const tO = o ? tokenize(o) : {tokens: [] as string[], at: new Map<string, Json>()};
  const tA = tokenize(a);
  const tB = tokenize(b);

  // Content of each element (including deletions and element-level conflicts)
  // is merged independently by identity.
  const outcomes = new Map<string, Outcome>();
  for (const token of new Set([...tA.tokens, ...tB.tokens, ...tO.tokens])) {
    outcomes.set(
      token,
      mergeNode(
        [...path, ELEM],
        tO.at.get(token),
        tA.at.get(token),
        tB.at.get(token),
      ),
    );
  }
  const survives = (token: string): boolean => outcomes.get(token)?.present ?? false;
  const seqA = tA.tokens.filter(survives);
  const seqB = tB.tokens.filter(survives);
  const reorderedA = o ? isReordered(tO.tokens, tA.tokens, survives) : false;
  const reorderedB = o ? isReordered(tO.tokens, tB.tokens, survives) : false;

  let finalTokens: string[];
  let orderConflict = false;
  if (!reorderedA && !reorderedB) {
    // Neither side moved shared elements: keep one side's positions (its shared
    // order is still the base order) and append the other side's additions.
    finalTokens = dedupeAppend(seqA.length >= seqB.length ? seqA : seqB, seqA.length >= seqB.length ? seqB : seqA);
  } else if (reorderedA && !reorderedB) {
    finalTokens = dedupeAppend(seqA, seqB);
  } else if (!reorderedA && reorderedB) {
    finalTokens = dedupeAppend(seqB, seqA);
  } else {
    // Both sides reordered: compatible if the shared elements agree on order.
    const shared = new Set(seqA.filter(t => seqB.includes(t)));
    if (JSON.stringify(seqA.filter(t => shared.has(t))) === JSON.stringify(seqB.filter(t => shared.has(t)))) {
      finalTokens = dedupeAppend(seqA.filter(t => shared.has(t)), dedupeAppend(seqA, seqB));
    } else {
      orderConflict = true;
      // Placeholder follows the remote order; the user picks a side explicitly.
      finalTokens = dedupeAppend(seqB, seqA);
    }
  }

  const value: Json[] = [];
  const conflicts: Conflict[] = [];
  finalTokens.forEach((token, index) => {
    const outcome = outcomes.get(token)!;
    value.push(outcome.value as Json);
    for (const conflict of outcome.conflicts) {
      if (conflict.path[path.length] === ELEM) conflict.path[path.length] = index;
      conflicts.push(conflict);
    }
  });

  if (orderConflict) {
    conflicts.push({
      path: path.slice(),
      kind: 'array-order',
      base: o,
      local: a,
      remote: b,
      basePresent: o !== undefined,
      localPresent: true,
      remotePresent: true,
    });
  }

  return {present: true, value, conflicts};
}

function dedupeAppend(primary: string[], extra: string[]): string[] {
  const seen = new Set(primary);
  const result = [...primary];
  for (const token of extra) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

function mergeNode(path: Path, o: Json | undefined, a: Json | undefined, b: Json | undefined): Outcome {
  const aPresent = a !== undefined;
  const bPresent = b !== undefined;

  if (aPresent && bPresent && deepEqual(a, b)) return present(a);
  if (!aPresent && !bPresent) return present(undefined); // deleted on both sides

  if (aPresent !== bPresent) {
    // One side deleted / never had the node.
    const survivor = aPresent ? a : b;
    if (o === undefined) return present(survivor); // lone addition
    if (deepEqual(survivor, o)) return present(undefined); // delete vs untouched
    return valueConflict(path, o, a, b); // delete vs edit
  }

  // Both sides have the node and they differ. A side that left the baseline
  // untouched simply loses, regardless of whether the other side is structured.
  if (o !== undefined && deepEqual(a, o)) return present(b);
  if (o !== undefined && deepEqual(b, o)) return present(a);
  // Otherwise descend into structured values so disjoint child edits merge
  // automatically and only paths that truly disagree become conflicts.
  if (Array.isArray(a) && Array.isArray(b)) {
    return mergeArray(path, Array.isArray(o) ? o : undefined, a, b);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return mergeObject(path, isPlainObject(o) ? o : undefined, a, b);
  }
  // Scalars (or a type mismatch) diverged: user must choose.
  return valueConflict(path, o, a, b);
}

export function threeWayMerge(base: Json, local: Json, remote: Json): {merged: Json; conflicts: Conflict[]} {
  const outcome = mergeNode([], base, local, remote);
  return {
    merged: outcome.present ? (outcome.value as Json) : null,
    conflicts: outcome.conflicts,
  };
}

export function conflictKey(conflict: Conflict): string {
  return '$' + conflict.path.map(segment =>
    typeof segment === 'number' ? `[${segment}]` : `.${segment}`,
  ).join('');
}

// --- Applying resolved choices back onto the auto-merged document ----------

function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function setPath(target: Json, path: Path, value: Json): void {
  let node: any = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const next = path[i + 1];
    const key = typeof next === 'number' ? [] : {};
    node = node[segment as any] ?? (node[segment as any] = key);
  }
  node[path[path.length - 1] as any] = value;
}

function deletePath(target: Json, path: Path): void {
  let node: any = target;
  for (const segment of path.slice(0, -1)) node = node[segment as any];
  const last = path[path.length - 1];
  if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1);
  else delete node[last as any];
}

function reorderArray(arr: Json[], reference: Json[]): Json[] {
  const current = tokenize(arr);
  const refTokens = tokenize(reference).tokens;
  const used = new Set<string>();
  const ordered: Json[] = [];
  for (const token of refTokens) {
    if (current.at.has(token) && !used.has(token)) {
      ordered.push(current.at.get(token)!);
      used.add(token);
    }
  }
  for (const [index, token] of current.tokens.entries()) {
    if (!used.has(token)) {
      ordered.push(arr[index]);
      used.add(token);
    }
  }
  return ordered;
}

export function applyChoices(
  merged: Json,
  conflicts: Conflict[],
  choices: Record<string, 'local' | 'remote'>,
): Json {
  const result = deepClone(merged);
  // Apply value edits first; higher array indices first so deletes stay valid.
  const valueConflicts = conflicts
    .filter(c => c.kind === 'value' && choices[conflictKey(c)])
    .sort((x, y) => {
      const length = Math.min(x.path.length, y.path.length);
      for (let i = 0; i < length; i++) {
        const sx = x.path[i];
        const sy = y.path[i];
        if (sx === sy) continue;
        if (typeof sx === 'number' && typeof sy === 'number') return sy - sx;
        return String(sx) < String(sy) ? -1 : 1;
      }
      return y.path.length - x.path.length;
    });
  for (const conflict of valueConflicts) {
    const side = choices[conflictKey(conflict)];
    const chosen = side === 'local' ? conflict.local : conflict.remote;
    if (chosen === undefined) deletePath(result, conflict.path);
    else setPath(result, conflict.path, deepClone(chosen));
  }
  for (const conflict of conflicts) {
    if (conflict.kind !== 'array-order') continue;
    const side = choices[conflictKey(conflict)];
    if (!side) continue;
    const reference = (side === 'local' ? conflict.local : conflict.remote) as Json[];
    const current = conflict.path.length === 0 ? result : (conflict.path.slice(0, -1) as Path)
      .reduce<any>((node, segment) => node?.[segment as any], result)?.[conflict.path[conflict.path.length - 1] as any];
    if (Array.isArray(current)) {
      const reordered = reorderArray(current, reference);
      if (conflict.path.length === 0) {
        // Root is an array: replace in place via mutation the caller keeps.
        (result as any[]).splice(0, (result as any[]).length, ...reordered);
      } else {
        setPath(result, conflict.path, reordered);
      }
    }
  }
  return result;
}
