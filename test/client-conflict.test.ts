import {describe, expect, it} from 'vitest';
import {buildConflictState, resolveConflict, resolvedDocument, unresolvedCount} from '../src/client/conflict.js';
import {createDraftStore, type DraftStore} from '../src/client/drafts.js';
import type {Json} from '../src/shared/merge.js';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

function store(): DraftStore {
  return createDraftStore(new MemoryStorage());
}

const baseline: Json = {
  properties: {
    id: {type: 'string'},
    total: {type: 'number'},
    tags: [{id: 'a'}, {id: 'b'}],
  },
};

describe('draft persistence', () => {
  it('keeps the unresolved local draft after reload, together with its editing baseline', () => {
    const drafts = store();
    drafts.saveDraft({
      contractId: 'orders',
      text: '{"properties":{"total":{"type":"integer"}}}',
      baseline,
      baselineRevision: 10,
      savedAt: 1,
    });
    const loaded = drafts.loadDraft('orders');
    expect(loaded?.baselineRevision).toBe(10);
    expect(loaded?.text).toContain('integer');
    expect(loaded?.baseline).toEqual(baseline);
  });

  it('scopes drafts per contract and ignores foreign/corrupt entries', () => {
    const drafts = store();
    drafts.saveDraft({contractId: 'orders', text: '{}', baseline: {}, baselineRevision: 1, savedAt: 1});
    expect(drafts.loadDraft('profiles')).toBeNull();
    drafts.clearDraft('orders');
    expect(drafts.loadDraft('orders')).toBeNull();
  });
});

describe('draft re-confirmation after refresh', () => {
  it('re-runs the three-way merge against the freshly fetched remote revision', () => {
    const localText = JSON.stringify({...baseline, properties: {...(baseline as any).properties, total: {type: 'integer'}}});
    const drafts = store();
    drafts.saveDraft({
      contractId: 'orders',
      text: localText,
      baseline,
      baselineRevision: 10,
      savedAt: 1,
    });

    // Meanwhile the server advanced to 11 with a disjoint edit (id gained a format).
    const latest: Json = {
      properties: {
        id: {type: 'string', format: 'uuid'},
        total: {type: 'number'},
        tags: [{id: 'a'}, {id: 'b'}],
      },
    };
    const draft = drafts.loadDraft('orders')!;
    const local = JSON.parse(draft.text) as Json;
    const state = buildConflictState({
      baseline: draft.baseline,
      baselineRevision: draft.baselineRevision,
      latest,
      latestRevision: 11,
      latestVersion: '11-abc',
      local,
    });
    expect(state.conflicts).toHaveLength(0);
    expect(state.expectedVersion).toBe('11-abc');
    expect(resolvedDocument(state)).toEqual({
      properties: {id: {type: 'string', format: 'uuid'}, total: {type: 'integer'}, tags: [{id: 'a'}, {id: 'b'}]},
    });
  });

  it('re-applies previous per-field choices when the server moves again', () => {
    // Initial conflict on total.type: local boolean vs remote integer.
    let state = buildConflictState({
      baseline,
      baselineRevision: 10,
      latest: {properties: {...(baseline as any).properties, total: {type: 'integer'}}},
      latestRevision: 11,
      latestVersion: '11-aaa',
      local: {properties: {...(baseline as any).properties, total: {type: 'boolean'}}},
    });
    expect(state.conflicts.map(c => c.path.join('/'))).toEqual(['properties/total/type']);
    state = resolveConflict(state, ['properties', 'total', 'type'], 'local');
    expect(unresolvedCount(state)).toBe(0);
    expect((resolvedDocument(state) as any).properties.total).toEqual({type: 'boolean'});

    // Server advances again: A changes total.type once more (to number) and also
    // adds a format to id (disjoint). B retries its resolved document against
    // revision 11; total.type diverges again and the previous choice sticks.
    const advanced: Json = {
      properties: {
        id: {type: 'string', format: 'uuid'},
        total: {type: 'number'},
        tags: [{id: 'a'}, {id: 'b'}],
      },
    };
    const state2 = buildConflictState({
      baseline: {properties: {...(baseline as any).properties, total: {type: 'integer'}}},
      baselineRevision: 11,
      latest: advanced,
      latestRevision: 12,
      latestVersion: '12-bbb',
      local: resolvedDocument(state),
      previousChoices: state.choices,
    });
    expect(state2.conflicts.map(c => c.path.join('/'))).toEqual(['properties/total/type']);
    expect(state2.choices[Object.keys(state2.choices)[0]]).toBe('local');
    expect(unresolvedCount(state2)).toBe(0);
    expect((resolvedDocument(state2) as any).properties.id).toEqual({type: 'string', format: 'uuid'});
    expect((resolvedDocument(state2) as any).properties.total).toEqual({type: 'boolean'});
  });
});
