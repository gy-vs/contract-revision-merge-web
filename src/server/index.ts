import crypto from 'node:crypto';
import express from 'express';
import {fileURLToPath} from 'node:url';
import {threeWayMerge, type Conflict, type Json} from '../shared/merge.js';

type Contract = {id: string; name: string; revision: number; schema: Record<string, Json>};

const contracts: Contract[] = [
  {id: 'orders', name: 'Order event', revision: 4, schema: {type: 'object', properties: {id: {type: 'string'}, total: {type: 'number'}}}},
  {id: 'profiles', name: 'Profile event', revision: 7, schema: {type: 'object', properties: {name: {type: 'string'}, locale: {type: 'string'}}}},
];

interface RevisionSnapshot {
  revision: number;
  schema: Record<string, Json>;
}

const history = new Map<string, RevisionSnapshot[]>(contracts.map(c => [
  c.id,
  [{revision: c.revision, schema: JSON.parse(JSON.stringify(c.schema))}],
]));
const HISTORY_LIMIT = 100;

// Strong opaque version identifier: monotonic revision plus a content hash.
function makeVersion(revision: number, schema: Record<string, Json>): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 10);
  return `${revision}-${digest}`;
}

function findContract(id: string): Contract | undefined {
  return contracts.find(item => item.id === id);
}

function publicContract(contract: Contract) {
  return {...contract, version: makeVersion(contract.revision, contract.schema)};
}

function findSnapshot(id: string, revision: number): RevisionSnapshot | undefined {
  return (history.get(id) ?? []).find(snapshot => snapshot.revision === revision);
}

function recordSnapshot(contract: Contract): void {
  const list = history.get(contract.id)!;
  list.push({revision: contract.revision, schema: JSON.parse(JSON.stringify(contract.schema))});
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
}

function resolveRefs(value: unknown): unknown { return value; }

function parseExpectedVersion(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const trimmed = value.replace(/^"|"$/g, '');
  const match = /^(\d+)(?:-[0-9a-f]+)?$/.exec(trimmed);
  return match ? Number(match[1]) : undefined;
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.get('/api/bootstrap', (_req, res) => res.json({kind: 'contract', count: contracts.length}));
  app.get('/api/contracts', (_req, res) =>
    res.json(contracts.map(contract => ({
      id: contract.id,
      name: contract.name,
      revision: contract.revision,
      version: makeVersion(contract.revision, contract.schema),
    }))));
  app.get('/api/contracts/:id', (req, res) => {
    const contract = findContract(req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    res.set('ETag', `"${makeVersion(contract.revision, contract.schema)}"`).json(publicContract(contract));
  });
  app.post('/api/contracts/:id/preview', async (req, res) => {
    const delay = req.params.id === 'orders' ? 240 : 30;
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const schema = resolveRefs(req.body.schema);
      res.json({contractId: req.params.id, valid: true, schema});
    } catch (error) {
      res.status(422).json({contractId: req.params.id, valid: false, error: String(error)});
    }
  });
  // Conditional update. The client must present the revision it edited from.
  app.put('/api/contracts/:id', (req, res) => {
    const contract = findContract(req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    if (!req.body || typeof req.body !== 'object' || typeof req.body.schema !== 'object' || req.body.schema === null) {
      return res.status(400).json({error: 'invalid_schema'});
    }
    const headerRevision = parseExpectedVersion(req.header('If-Match'));
    const expectedRevision = headerRevision ?? parseExpectedVersion(req.body.expectedVersion);
    if (expectedRevision === undefined) {
      return res.status(428).json({
        error: 'version_required',
        currentVersion: makeVersion(contract.revision, contract.schema),
        currentRevision: contract.revision,
      });
    }

    const localSchema = req.body.schema as Record<string, Json>;
    const currentVersion = makeVersion(contract.revision, contract.schema);

    // Fast path: the client is up to date.
    if (expectedRevision === contract.revision) {
      contract.schema = JSON.parse(JSON.stringify(localSchema));
      contract.revision += 1;
      recordSnapshot(contract);
      res.set('ETag', `"${makeVersion(contract.revision, contract.schema)}"`);
      return res.json({...publicContract(contract), autoMerged: false});
    }

    // Stale base: require the baseline snapshot for a three-way merge.
    const baseline = findSnapshot(contract.id, expectedRevision);
    if (!baseline) {
      return res.status(409).json({
        error: 'baseline_unknown',
        message: 'The baseline revision is no longer available; please reload.',
        baselineRevision: expectedRevision,
        currentRevision: contract.revision,
        currentVersion,
        latest: publicContract(contract),
        conflictFields: [],
      });
    }

    const {merged, conflicts} = threeWayMerge(
      baseline.schema,
      localSchema,
      contract.schema,
    );

    if (conflicts.length > 0) {
      return res.status(409).json({
        error: 'version_conflict',
        message: 'The contract changed on the server since you started editing.',
        baselineRevision: baseline.revision,
        currentRevision: contract.revision,
        baselineVersion: makeVersion(baseline.revision, baseline.schema),
        currentVersion,
        baseline: baseline.schema,
        latest: publicContract(contract),
        merged,
        conflictFields: serializeConflicts(conflicts),
      });
    }

    // The write would not change anything compared with the current document.
    // Still reject the stale condition: the client must acknowledge the newer
    // revision instead of silently writing against an outdated base.
    if (JSON.stringify(merged) === JSON.stringify(contract.schema)) {
      return res.status(409).json({
        error: 'version_conflict',
        message: 'The document already matches the server, but your base revision is stale.',
        baselineRevision: baseline.revision,
        currentRevision: contract.revision,
        baselineVersion: makeVersion(baseline.revision, baseline.schema),
        currentVersion,
        baseline: baseline.schema,
        latest: publicContract(contract),
        merged,
        conflictFields: [],
      });
    }

    // Disjoint changes: merge automatically and accept the write.
    contract.schema = merged as Record<string, Json>;
    contract.revision += 1;
    recordSnapshot(contract);
    res.set('ETag', `"${makeVersion(contract.revision, contract.schema)}"`);
    return res.json({...publicContract(contract), autoMerged: true, mergedFromRevision: baseline.revision});
  });
  app.post('/api/contracts/:id/validate-all', (_req, res) => res.json({results: [{id: 'sample-1', valid: true}]}));
  return app;
}

function serializeConflicts(conflicts: Conflict[]) {
  return conflicts.map(conflict => ({
    path: conflict.path.map(segment => String(segment)),
    kind: conflict.kind,
    base: conflict.base,
    local: conflict.local,
    remote: conflict.remote,
    basePresent: conflict.basePresent,
    localPresent: conflict.localPresent,
    remotePresent: conflict.remotePresent,
  }));
}

// Test helper: reset the in-memory store to a deterministic fixture.
export function resetStore(fixtures?: Contract[]): void {
  contracts.splice(0, contracts.length);
  history.clear();
  if (fixtures) contracts.push(...fixtures);
  for (const contract of contracts) {
    history.set(contract.id, [{revision: contract.revision, schema: JSON.parse(JSON.stringify(contract.schema))}]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
