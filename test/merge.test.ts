import {describe, expect, it} from 'vitest';
import {
  applyResolution,
  changedPaths,
  deserializeConflict,
  formatPath,
  getAtPath,
  MISSING,
  serializeConflict,
  threeWayMerge,
} from '../src/shared/merge';

describe('threeWayMerge', () => {
  it('auto-merges non-conflicting changes at nested paths', () => {
    const base = {meta: {version: 1, title: 'a'}, properties: {id: {type: 'string'}}};
    const local = {meta: {version: 1, title: 'a'}, properties: {id: {type: 'string', description: 'local note'}}};
    const remote = {meta: {version: 2, title: 'a'}, properties: {id: {type: 'string'}}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({meta: {version: 2, title: 'a'}, properties: {id: {type: 'string', description: 'local note'}}});
  });

  it('flags a conflict when both sides change the same leaf differently', () => {
    const base = {a: {b: 1}};
    const {merged, conflicts} = threeWayMerge(base, {a: {b: 2}}, {a: {b: 3}});
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({path: ['a', 'b'], base: 1, local: 2, remote: 3});
    // The auto-merged document keeps the remote value until the user resolves.
    expect(merged).toEqual({a: {b: 3}});
  });

  it('does not conflict when both sides make the identical change', () => {
    const base = {a: 1, b: {c: 1}};
    const local = {a: 1, b: {c: 5}};
    const remote = {a: 1, b: {c: 5}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual(remote);
  });

  it('handles field deletion vs untouched remote as an auto-merge', () => {
    const base = {a: 1, b: {c: 1, d: 2}};
    const local = {a: 1, b: {c: 1}};
    const remote = {a: 9, b: {c: 1, d: 2}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({a: 9, b: {c: 1}});
  });

  it('conflicts when one side deletes a field the other side modified', () => {
    const base = {b: {c: 1, d: 2}};
    const local = {b: {d: 2}};
    const remote = {b: {c: 99, d: 2}};
    const {conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toEqual(['b', 'c']);
    expect(conflicts[0].local).toBe(MISSING);
    expect(conflicts[0].remote).toBe(99);
  });

  it('does not conflict when both sides delete the same field', () => {
    const base = {a: 1, b: 2};
    const {merged, conflicts} = threeWayMerge(base, {b: 2}, {b: 2});
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({b: 2});
  });

  it('conflicts when one side deletes a subtree the other edits inside', () => {
    const base = {meta: {version: 1, title: 'a'}, keep: true};
    const local = {keep: true};
    const remote = {meta: {version: 2, title: 'a'}, keep: true};
    const {conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toEqual(['meta']);
    expect(conflicts[0].local).toBe(MISSING);
  });

  it('treats array reordering as a change and auto-merges a one-sided reorder', () => {
    const base = {required: ['id', 'total', 'currency']};
    const local = {required: ['id', 'total', 'currency']};
    const remote = {required: ['currency', 'id', 'total']};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({required: ['currency', 'id', 'total']});
  });

  it('conflicts when both sides change the same array differently', () => {
    const base = {required: ['a', 'b']};
    const local = {required: ['b', 'a']};
    const remote = {required: ['a', 'b', 'c']};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toEqual(['required']);
    expect(merged).toEqual({required: ['a', 'b', 'c']});
  });

  it('conflicts on parent/child changes at overlapping paths', () => {
    const base = {meta: {version: 1}};
    // Local replaces the whole subtree; remote edits a child inside it.
    const local = {meta: 'frozen'};
    const remote = {meta: {version: 2}};
    const {conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toEqual(['meta']);
    expect(conflicts[0].local).toBe('frozen');
    expect(conflicts[0].remote).toEqual({version: 2});
  });

  it('conflicts when remote replaces a parent the local side edited inside', () => {
    const base = {meta: {version: 1}};
    const local = {meta: {version: 1, extra: true}};
    const remote = {meta: [1, 2, 3]};
    const {conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toEqual(['meta']);
  });

  it('auto-merges when local already contains the remote change at an ancestor', () => {
    const base = {meta: {version: 1}};
    const local = {meta: {version: 2, extra: true}};
    const remote = {meta: {version: 2}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({meta: {version: 2, extra: true}});
  });

  it('conflicts when both sides add the same new field with different values', () => {
    const base = {a: 1};
    const {merged, conflicts} = threeWayMerge(base, {a: 1, b: 'local'}, {a: 1, b: 'remote'});
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toEqual(['b']);
    expect(conflicts[0].base).toBe(MISSING);
    expect(merged).toEqual({a: 1, b: 'remote'});
  });
});

describe('applyResolution', () => {
  const base = {a: {b: 1, c: 2}, list: [1, 2]};

  it('applies the local choice at the conflict path', () => {
    const {merged, conflicts} = threeWayMerge(base, {a: {b: 7, c: 2}, list: [1, 2]}, {a: {b: 9, c: 2}, list: [1, 2]});
    const resolved = applyResolution(merged, conflicts[0], 'local');
    expect(resolved).toEqual({a: {b: 7, c: 2}, list: [1, 2]});
  });

  it('applies the remote choice at the conflict path', () => {
    const {merged, conflicts} = threeWayMerge(base, {a: {b: 7, c: 2}, list: [1, 2]}, {a: {b: 9, c: 2}, list: [1, 2]});
    const resolved = applyResolution(merged, conflicts[0], 'remote');
    expect(resolved).toEqual({a: {b: 9, c: 2}, list: [1, 2]});
  });

  it('applies a deletion when the chosen side has no value', () => {
    const {merged, conflicts} = threeWayMerge(base, {a: {c: 2}, list: [1, 2]}, {a: {b: 9, c: 2}, list: [1, 2]});
    expect(conflicts[0].path).toEqual(['a', 'b']);
    const resolved = applyResolution(merged, conflicts[0], 'local');
    expect(resolved).toEqual({a: {c: 2}, list: [1, 2]});
  });
});

describe('conflict serialization', () => {
  it('round-trips MISSING values through omitted JSON keys', () => {
    const conflict = {path: ['a', 'b'], base: 1, local: MISSING, remote: 2};
    const wire = JSON.parse(JSON.stringify(serializeConflict(conflict)));
    expect(wire).toEqual({path: ['a', 'b'], base: 1, remote: 2});
    const restored = deserializeConflict(wire);
    expect(restored.local).toBe(MISSING);
    expect(restored.base).toBe(1);
  });
});

describe('path helpers', () => {
  it('formats paths for display', () => {
    expect(formatPath([])).toBe('$');
    expect(formatPath(['properties', 'id', 'type'])).toBe('$.properties.id.type');
    expect(formatPath(['items', 2, 'name'])).toBe('$.items[2].name');
  });

  it('reads nested values and reports MISSING for absent paths', () => {
    expect(getAtPath({a: {b: 1}}, ['a', 'b'])).toBe(1);
    expect(getAtPath({a: {b: 1}}, ['a', 'x'])).toBe(MISSING);
    expect(getAtPath({a: 1}, ['a', 'b'])).toBe(MISSING);
  });

  it('reports changed paths recursively, with arrays atomic', () => {
    expect(changedPaths({a: 1}, {a: 1})).toEqual([]);
    expect(changedPaths({a: {b: 1, c: 2}}, {a: {b: 1, c: 3}})).toEqual([['a', 'c']]);
    expect(changedPaths({list: [1, 2]}, {list: [2, 1]})).toEqual([['list']]);
    expect(changedPaths({a: {b: 1}}, {a: {}})).toEqual([['a', 'b']]);
  });
});
