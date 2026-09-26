import {describe, expect, it} from 'vitest';
import {applyChoices, conflictKey, threeWayMerge, type Json} from '../src/shared/merge.js';

function onlyPaths(conflicts: {path: (string | number)[]}[]): string[] {
  return conflicts.map(c => c.path.map(String).join('/'));
}

function resolveAll(merged: Json, conflicts: ReturnType<typeof threeWayMerge>['conflicts'], side: 'local' | 'remote'): Json {
  const choices = Object.fromEntries(conflicts.map(c => [conflictKey(c), side]));
  return applyChoices(merged, conflicts, choices);
}

describe('threeWayMerge — automatic merges', () => {
  it('merges disjoint field edits at any depth', () => {
    const base = {type: 'object', properties: {id: {type: 'string'}, total: {type: 'number'}}};
    const local = {type: 'object', properties: {id: {type: 'string', format: 'uuid'}, total: {type: 'number'}}};
    const remote = {type: 'object', properties: {id: {type: 'string'}, total: {type: 'integer'}}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual({
      type: 'object',
      properties: {id: {type: 'string', format: 'uuid'}, total: {type: 'integer'}},
    });
  });

  it('merges a field deletion on one side with an edit elsewhere on the other', () => {
    const base = {a: 1, b: {c: 2, d: 3}};
    const local = {a: 1, b: {c: 2}}; // local deletes b.d
    const remote = {a: 9, b: {c: 2, d: 3}}; // remote edits a
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual({a: 9, b: {c: 2}});
  });

  it('agrees on deletion when both sides delete the same path', () => {
    const base = {a: 1, gone: 2};
    const local = {a: 1};
    const remote = {a: 1};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual({a: 1});
  });

  it('weaves independent array reorder and element edit together', () => {
    const base = {fields: [{id: 'a', type: 'string'}, {id: 'b', type: 'string'}]};
    const local = {fields: [{id: 'b', type: 'string'}, {id: 'a', type: 'string'}]}; // reorder
    const remote = {fields: [{id: 'a', type: 'uuid'}, {id: 'b', type: 'string'}]}; // edit a
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual({
      fields: [{id: 'b', type: 'string'}, {id: 'a', type: 'uuid'}],
    });
  });

  it('keeps elements independently added at different positions by each side', () => {
    const base = {fields: [{id: 'a'}]};
    const local = {fields: [{id: 'x'}, {id: 'a'}]};
    const remote = {fields: [{id: 'a'}, {id: 'y'}]};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(0);
    const ids = (merged as {fields: {id: string}[]}).fields.map(f => f.id).sort();
    expect(ids).toEqual(['a', 'x', 'y']);
  });

  it('merges a parent reorder with a child edit on the other side', () => {
    const base = [{id: 'a', spec: {v: 1}}, {id: 'b', spec: {v: 2}}];
    const local = [{id: 'b', spec: {v: 2}}, {id: 'a', spec: {v: 1}}];
    const remote = [{id: 'a', spec: {v: 10}}, {id: 'b', spec: {v: 2}}];
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged).toEqual([{id: 'b', spec: {v: 2}}, {id: 'a', spec: {v: 10}}]);
  });
});

describe('threeWayMerge — conflicts', () => {
  it('flags edit-vs-edit at the exact path, not just top level', () => {
    const base = {props: {name: {type: 'string'}, age: {type: 'number'}}};
    const local = {props: {name: {type: 'uuid', minLength: 2}, age: {type: 'number'}}};
    const remote = {props: {name: {type: 'integer', maxLength: 9}, age: {type: 'number'}}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    // type/minLength/maxLength are siblings: minLength merges automatically,
    // the same key `type` diverges and is the real conflict.
    expect(onlyPaths(conflicts)).toEqual(['props/name/type']);
    expect((merged as any).props.name.type).toBe('integer');
    expect((merged as any).props.name.minLength).toBe(2);
    const localPick = resolveAll(merged, conflicts, 'local');
    expect(localPick).toMatchObject({props: {name: {type: 'uuid', minLength: 2}}});
  });

  it('flags delete-vs-edit with the survivor as placeholder', () => {
    const base = {a: {x: 1}};
    const local = {};
    const remote = {a: {x: 2}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(onlyPaths(conflicts)).toEqual(['a']);
    const conflict = conflicts[0];
    expect(conflict.localPresent).toBe(false);
    expect(conflict.remotePresent).toBe(true);
    expect(merged).toEqual({a: {x: 2}});
    // Choosing local (deletion) removes the node.
    expect(resolveAll(merged, conflicts, 'local')).toEqual({});
  });

  it('flags an array-order conflict when both sides reorder differently', () => {
    const base = {fields: [{id: 'a'}, {id: 'b'}, {id: 'c'}]};
    const local = {fields: [{id: 'c'}, {id: 'b'}, {id: 'a'}]};
    const remote = {fields: [{id: 'b'}, {id: 'a'}, {id: 'c'}]};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    expect(conflicts.map(c => c.kind)).toEqual(['array-order']);
    expect((resolveAll(merged, conflicts, 'local') as {fields: {id: string}[]}).fields.map(f => f.id))
      .toEqual(['c', 'b', 'a']);
    expect((resolveAll(merged, conflicts, 'remote') as {fields: {id: string}[]}).fields.map(f => f.id))
      .toEqual(['b', 'a', 'c']);
  });

  it('handles parent and child of the same path changing simultaneously', () => {
    // Local rewrites a wholesale (drops x/y, adds z); remote edits inside old a.
    const base = {a: {x: 1, y: 2}};
    const local = {a: {z: 9}};
    const remote = {a: {x: 1, y: 5}};
    const {merged, conflicts} = threeWayMerge(base, local, remote);
    // Only local-delete vs remote-edit on y is a real conflict; the local-only
    // addition z and the untouched x merge automatically.
    expect(onlyPaths(conflicts)).toEqual(['a/y']);
    expect(resolveAll(merged, conflicts, 'local')).toEqual({a: {z: 9}});
    // x is deleted by local and untouched by remote, so deletion wins even
    // when the y conflict is resolved toward the remote value.
    expect(resolveAll(merged, conflicts, 'remote')).toEqual({a: {y: 5, z: 9}});
  });

  it('flags add-vs-add for two different values at the same new path', () => {
    const base = {};
    const local = {newField: 1};
    const remote = {newField: 2};
    const {conflicts} = threeWayMerge(base, local, remote);
    expect(onlyPaths(conflicts)).toEqual(['newField']);
    expect(conflicts[0].basePresent).toBe(false);
  });

  it('reports nested array element conflicts using final indices', () => {
    const base = {fields: [{id: 'a', type: 'string'}, {id: 'b', type: 'string'}]};
    const local = {fields: [{id: 'a', type: 'integer'}, {id: 'b', type: 'string'}]};
    const remote = {fields: [{id: 'a', type: 'boolean'}, {id: 'b', type: 'string'}]};
    const {conflicts} = threeWayMerge(base, local, remote);
    expect(onlyPaths(conflicts)).toEqual(['fields/0/type']);
    expect(conflicts[0].local).toBe('integer');
    expect(conflicts[0].remote).toBe('boolean');
  });
});
