import {beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp, resetStore} from '../src/server/index.js';
import type {Json} from '../src/shared/merge.js';

interface StoredContract {
  id: string;
  name: string;
  revision: number;
  schema: Record<string, Json>;
}

interface TestSchema {
  type: string;
  properties: {
    id: Record<string, Json>;
    total?: Record<string, Json>;
    status: Record<string, Json>;
    tags: Json;
  };
}

const baseContract: StoredContract = {
  id: 'orders',
  name: 'Order event',
  revision: 10,
  schema: {
    type: 'object',
    properties: {
      id: {type: 'string'},
      total: {type: 'number'},
      status: {type: 'string', enum: ['new', 'paid']},
      tags: [{id: 'a'}, {id: 'b'}],
    },
  },
};

function app() {
  return request(createApp());
}

beforeEach(() => {
  resetStore([JSON.parse(JSON.stringify(baseContract))]);
});

function clientView(body: any) {
  return {revision: body.revision as number, version: body.version as string, schema: body.schema as unknown as TestSchema};
}

async function open() {
  const response = await app().get('/api/contracts/orders');
  return clientView(response.body);
}

async function put(view: {version: string}, schema: TestSchema) {
  return app()
    .put('/api/contracts/orders')
    .set('content-type', 'application/json')
    .send({schema, expectedVersion: view.version});
}

function clone(schema: TestSchema): TestSchema {
  return JSON.parse(JSON.stringify(schema));
}

describe('optimistic concurrency — two clients', () => {
  it('interleaved saves: disjoint edits auto-merge, conflicting edit returns a 409 with base/latest/fields', async () => {
    // Both browsers load revision 10.
    const clientA = await open();
    const clientB = await open();
    expect(clientA.version).toMatch(/^10-[0-9a-f]{10}$/);

    // Client A saves first: changes the total type to integer, bumps to 11.
    const aFirst = {...clientA.schema, properties: {...clientA.schema.properties, total: {type: 'integer'}}};
    const savedA = await put(clientA, aFirst);
    expect(savedA.status).toBe(200);
    expect(savedA.body.autoMerged).toBe(false);
    expect(savedA.body.revision).toBe(11);
    expect(savedA.headers.etag).toBe(`"${savedA.body.version}"`);

    // Client B (still on revision 10) edits a disjoint field: auto-merge, revision 12.
    const bDisjoint = {...clientB.schema, properties: {...clientB.schema.properties, id: {type: 'string', format: 'uuid'}}};
    const mergedB = await put(clientB, bDisjoint);
    expect(mergedB.status).toBe(200);
    expect(mergedB.body.autoMerged).toBe(true);
    expect(mergedB.body.revision).toBe(12);
    expect(mergedB.body.schema.properties.total).toEqual({type: 'integer'});
    expect(mergedB.body.schema.properties.id).toEqual({type: 'string', format: 'uuid'});

    // Client B now edits the SAME leaf (total.type) A already changed, stale base 10.
    const bConflict = clone(bDisjoint);
    bConflict.properties.total = {type: 'boolean'};
    const rejected = await put(clientB, bConflict);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('version_conflict');
    expect(rejected.body.baselineRevision).toBe(10);
    expect(rejected.body.currentRevision).toBe(12);
    expect(rejected.body.baseline).toEqual(baseContract.schema);
    expect(rejected.body.latest.schema).toEqual(mergedB.body.schema);
    expect(rejected.body.conflictFields.map((f: {path: string[]}) => f.path.join('/')))
      .toEqual(['properties/total/type']);
    const field = rejected.body.conflictFields[0];
    expect(field.local).toBe('boolean');
    expect(field.remote).toBe('integer');
    // The placeholder merge keeps the remote conflict value; B's disjoint edit survives.
    expect(rejected.body.merged.properties.id).toEqual({type: 'string', format: 'uuid'});
  });

  it('resolving conflicts and retrying succeeds against the new version', async () => {
    const clientA = await open();
    const clientB = await open();

    // A changes the total type to integer.
    const aSchema = {...clientA.schema, properties: {...clientA.schema.properties, total: {type: 'integer'}}};
    const savedA = await put(clientA, aSchema);
    expect(savedA.status).toBe(200);
    expect(savedA.body.revision).toBe(11);

    // B deletes total while A changed it: delete-vs-edit conflict.
    const bSchema: TestSchema = {
      type: 'object',
      properties: {
        id: {type: 'string'},
        status: clientB.schema.properties.status,
        tags: clientB.schema.properties.tags,
      },
    };
    const rejected = await put(clientB, bSchema);
    expect(rejected.status).toBe(409);
    expect(rejected.body.conflictFields.map((f: {path: string[]; localPresent: boolean; remotePresent: boolean}) => ({
      path: f.path.join('/'),
      localPresent: f.localPresent,
      remotePresent: f.remotePresent,
    }))).toEqual([{path: 'properties/total', localPresent: false, remotePresent: true}]);

    // B keeps the server (remote) value and retries against currentVersion.
    const retrySchema = rejected.body.merged as TestSchema;
    expect(retrySchema.properties.total).toEqual({type: 'integer'});
    const retried = await app()
      .put('/api/contracts/orders')
      .set('content-type', 'application/json')
      .send({schema: retrySchema, expectedVersion: rejected.body.currentVersion});
    expect(retried.status).toBe(200);
    expect(retried.body.revision).toBe(12);
    expect(retried.body.schema.properties.total).toEqual({type: 'integer'});

    // Retrying the same payload again with the now-consumed version must 409 again.
    const rejectedAgain = await app()
      .put('/api/contracts/orders')
      .set('content-type', 'application/json')
      .send({schema: retrySchema, expectedVersion: rejected.body.currentVersion});
    expect(rejectedAgain.status).toBe(409);
  });

  it('server moves again while conflicts are being resolved: retry returns a fresh 409 with both revisions advanced', async () => {
    const clientA = await open();
    const clientB = await open();

    // Revision 11: A changes total.type to integer.
    const a1 = {...clientA.schema, properties: {...clientA.schema.properties, total: {type: 'integer'}}};
    const savedA1 = await put(clientA, a1);
    expect(savedA1.status).toBe(200);
    expect(savedA1.body.revision).toBe(11);

    // B changes the same total.type differently (boolean), stale base 10.
    const b1: TestSchema = {
      ...clientB.schema,
      properties: {...clientB.schema.properties, total: {type: 'boolean'}},
    };
    const conflict1 = await put(clientB, b1);
    expect(conflict1.status).toBe(409);
    expect(conflict1.body.currentRevision).toBe(11);
    expect(conflict1.body.conflictFields.map((f: {path: string[]}) => f.path.join('/')))
      .toEqual(['properties/total/type']);

    // While B is resolving, A saves AGAIN (revision 12), changing total.type yet
    // again to number — the leaf B is about to commit moves a second time.
    const a2: TestSchema = {
      ...(savedA1.body.schema as TestSchema),
      properties: {
        ...(savedA1.body.schema as TestSchema).properties,
        total: {type: 'number'},
      },
    };
    const savedA2 = await app()
      .put('/api/contracts/orders')
      .set('content-type', 'application/json')
      .send({schema: a2, expectedVersion: savedA1.body.version});
    expect(savedA2.status).toBe(200);
    expect(savedA2.body.revision).toBe(12);

    // B chose local (boolean) and retries against revision 11 — but the server is at 12.
    const resolvedByB = clone(b1);
    resolvedByB.properties.total = {type: 'boolean'};
    const conflict2 = await app()
      .put('/api/contracts/orders')
      .set('content-type', 'application/json')
      .send({schema: resolvedByB, expectedVersion: conflict1.body.currentVersion});
    expect(conflict2.status).toBe(409);
    expect(conflict2.body.error).toBe('version_conflict');
    expect(conflict2.body.currentRevision).toBe(12);
    expect(conflict2.body.baselineRevision).toBe(11);
    // The remote now reflects A's revision-12 value.
    expect((conflict2.body.latest.schema as TestSchema).properties.total).toEqual({type: 'number'});
    expect(conflict2.body.conflictFields.map((f: {path: string[]}) => f.path.join('/')))
      .toEqual(['properties/total/type']);
    expect(conflict2.body.conflictFields[0].local).toBe('boolean');
    expect(conflict2.body.conflictFields[0].remote).toBe('number');

    // B finally accepts the new latest and retries against revision 12.
    const finalSchema = conflict2.body.merged as TestSchema;
    expect(finalSchema.properties.total).toEqual({type: 'number'});
    const final = await app()
      .put('/api/contracts/orders')
      .set('content-type', 'application/json')
      .send({schema: finalSchema, expectedVersion: conflict2.body.currentVersion});
    expect(final.status).toBe(200);
    expect(final.body.revision).toBe(13);
    expect((final.body.schema as TestSchema).properties.total).toEqual({type: 'number'});
  });

  it('accepts If-Match headers as the conditional version and 428s when no version is supplied', async () => {
    const client = await open();
    const noVersion = await app()
      .put('/api/contracts/orders')
      .send({schema: client.schema});
    expect(noVersion.status).toBe(428);
    expect(noVersion.body.currentRevision).toBe(10);

    const viaHeader = await app()
      .put('/api/contracts/orders')
      .set('If-Match', `"${client.version}"`)
      .send({schema: client.schema});
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.revision).toBe(11);
  });

  it('auto-merges a one-side array reorder with a disjoint element edit', async () => {
    const clientA = await open();
    const clientB = await open();

    // A reorders tags.
    const aSchema = clone(clientA.schema);
    aSchema.properties.tags = [{id: 'b'}, {id: 'a'}];
    const savedA = await put(clientA, aSchema);
    expect(savedA.status).toBe(200);

    // B edits the unrelated status field, based on revision 10.
    const bSchema = clone(clientB.schema);
    bSchema.properties.status = {type: 'string', enum: ['new', 'paid', 'shipped']};
    const mergedB = await put(clientB, bSchema);
    expect(mergedB.status).toBe(200);
    expect(mergedB.body.autoMerged).toBe(true);
    expect((mergedB.body.schema as TestSchema).properties.tags).toEqual([{id: 'b'}, {id: 'a'}]);
    expect(((mergedB.body.schema as TestSchema).properties.status as any).enum).toEqual(['new', 'paid', 'shipped']);
  });
});
