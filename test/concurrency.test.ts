import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {applyResolution, deserializeConflict, threeWayMerge, type WireConflict} from '../src/shared/merge';

const baseOrdersSchema = {
  type: 'object',
  properties: {id: {type: 'string'}, total: {type: 'number'}},
};

function putSchema(app: ReturnType<typeof createApp>, revision: number, schema: unknown) {
  return request(app).put('/api/contracts/orders').set('If-Match', `"${revision}"`).send({schema});
}

describe('conditional updates with strong revision ETags', () => {
  it('exposes a strong ETag on reads and requires If-Match on writes', async () => {
    const app = createApp();
    const read = await request(app).get('/api/contracts/orders');
    expect(read.status).toBe(200);
    expect(read.headers.etag).toBe('"4"');
    expect(read.body.revision).toBe(4);

    const missing = await request(app).put('/api/contracts/orders').send({schema: baseOrdersSchema});
    expect(missing.status).toBe(428);
    expect(missing.body.error).toBe('precondition_required');

    const weak = await request(app).put('/api/contracts/orders').set('If-Match', 'W/"4"').send({schema: baseOrdersSchema});
    expect(weak.status).toBe(400);

    const garbage = await request(app).put('/api/contracts/orders').set('If-Match', 'nope').send({schema: baseOrdersSchema});
    expect(garbage.status).toBe(400);
  });

  it('rejects the second of two interleaved saves with base, latest and conflicts', async () => {
    const app = createApp();
    // Both clients load revision 4.
    const clientA = await request(app).get('/api/contracts/orders');
    const clientB = await request(app).get('/api/contracts/orders');
    expect(clientA.headers.etag).toBe('"4"');
    expect(clientB.headers.etag).toBe('"4"');

    // Client A saves first: edits the id field.
    const schemaA = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'from A'}}};
    const saveA = await putSchema(app, 4, schemaA);
    expect(saveA.status).toBe(200);
    expect(saveA.headers.etag).toBe('"5"');
    expect(saveA.body.revision).toBe(5);

    // Client B saves its stale edit of the same field: rejected with a full conflict payload.
    const schemaB = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'from B'}}};
    const saveB = await putSchema(app, 4, schemaB);
    expect(saveB.status).toBe(409);
    expect(saveB.headers.etag).toBe('"5"');
    expect(saveB.body.error).toBe('revision_conflict');
    expect(saveB.body.baseRevision).toBe(4);
    expect(saveB.body.base).toEqual({revision: 4, schema: baseOrdersSchema});
    expect(saveB.body.latest).toEqual({revision: 5, schema: schemaA});
    expect(saveB.body.conflicts).toHaveLength(1);
    expect(saveB.body.conflicts[0]).toEqual({
      path: ['properties', 'id', 'description'],
      local: 'from B',
      remote: 'from A',
    });

    // The losing client's write must not have leaked into the stored contract.
    const after = await request(app).get('/api/contracts/orders');
    expect(after.body.revision).toBe(5);
    expect(after.body.schema).toEqual(schemaA);
  });

  it('auto-merges a stale write that touches disjoint fields, then accepts the retry', async () => {
    const app = createApp();
    // A edits properties.id; B (stale) edits properties.total — no overlap.
    const schemaA = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'from A'}}};
    await putSchema(app, 4, schemaA);

    const schemaB = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, total: {type: 'number', minimum: 0}}};
    const saveB = await putSchema(app, 4, schemaB);
    expect(saveB.status).toBe(409);
    expect(saveB.body.conflicts).toEqual([]);

    // What the client does on a conflict-free 409: merge locally and retry with the fresh ETag.
    const merged = threeWayMerge(saveB.body.base.schema, schemaB, saveB.body.latest.schema);
    expect(merged.conflicts).toEqual([]);
    const retry = await putSchema(app, saveB.body.latest.revision, merged.merged);
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(6);
    expect(retry.body.schema).toEqual({
      type: 'object',
      properties: {
        id: {type: 'string', description: 'from A'},
        total: {type: 'number', minimum: 0},
      },
    });
  });

  it('accepts the retry after the user resolves a real conflict', async () => {
    const app = createApp();
    const schemaA = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'from A'}}};
    await putSchema(app, 4, schemaA);

    const schemaB = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'from B'}}};
    const saveB = await putSchema(app, 4, schemaB);
    expect(saveB.status).toBe(409);

    // Client merges automatically, user picks the local value for the conflict, then retries.
    const conflicts = (saveB.body.conflicts as WireConflict[]).map(deserializeConflict);
    const merged = threeWayMerge(saveB.body.base.schema, schemaB, saveB.body.latest.schema);
    const resolved = applyResolution(merged.merged, conflicts[0], 'local');
    const retry = await putSchema(app, saveB.body.latest.revision, resolved);
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(6);
    expect(retry.body.schema.properties.id).toEqual({type: 'string', description: 'from B'});

    // Every intermediate revision stays retrievable as a merge baseline.
    const rev4 = await request(app).get('/api/contracts/orders/revisions/4');
    expect(rev4.body.schema).toEqual(baseOrdersSchema);
    const rev5 = await request(app).get('/api/contracts/orders/revisions/5');
    expect(rev5.body.schema).toEqual(schemaA);
    const gone = await request(app).get('/api/contracts/orders/revisions/99');
    expect(gone.status).toBe(404);
  });

  it('reports a fresh conflict when the server revision advances again before the retry', async () => {
    const app = createApp();
    const schemaA1 = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'A1'}}};
    await putSchema(app, 4, schemaA1);

    // B is now stale at rev 4.
    const schemaB = {...baseOrdersSchema, properties: {...baseOrdersSchema.properties, id: {type: 'string', description: 'from B'}}};
    const firstRejection = await putSchema(app, 4, schemaB);
    expect(firstRejection.status).toBe(409);
    expect(firstRejection.body.latest.revision).toBe(5);

    // A saves again before B retries: the server revision advances to 6.
    const schemaA2 = {...schemaA1, properties: {...schemaA1.properties, id: {type: 'string', description: 'A2'}}};
    const saveA2 = await putSchema(app, 5, schemaA2);
    expect(saveA2.status).toBe(200);
    expect(saveA2.body.revision).toBe(6);

    // B's retry against rev 5 is itself stale: a new 409 with rev 5 as baseline and rev 6 as latest.
    const secondRejection = await putSchema(app, 5, schemaB);
    expect(secondRejection.status).toBe(409);
    expect(secondRejection.body.baseRevision).toBe(5);
    expect(secondRejection.body.base.schema).toEqual(schemaA1);
    expect(secondRejection.body.latest).toEqual({revision: 6, schema: schemaA2});
    expect(secondRejection.body.conflicts).toEqual([
      {path: ['properties', 'id', 'description'], base: 'A1', local: 'from B', remote: 'A2'},
    ]);

    // Resolving against the newest state finally lands.
    const conflicts = (secondRejection.body.conflicts as WireConflict[]).map(deserializeConflict);
    const merged = threeWayMerge(secondRejection.body.base.schema, schemaB, secondRejection.body.latest.schema);
    const resolved = applyResolution(merged.merged, conflicts[0], 'remote');
    const retry = await putSchema(app, 6, resolved);
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(7);
    expect(retry.body.schema.properties.id).toEqual({type: 'string', description: 'A2'});
  });

  it('returns 409 without a baseline when the base revision is unknown', async () => {
    const app = createApp();
    const response = await putSchema(app, 999, baseOrdersSchema);
    expect(response.status).toBe(409);
    expect(response.body.base).toBeNull();
    expect(response.body.conflicts).toBeNull();
    expect(response.body.latest.revision).toBe(4);
  });
});
