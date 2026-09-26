import express from 'express';
import {fileURLToPath} from 'node:url';
import {clone, serializeConflict, threeWayMerge} from '../shared/merge';

type Contract = {id: string; name: string; revision: number; schema: Record<string, unknown>};

function seedContracts(): Contract[] {
  return [
    {id: 'orders', name: 'Order event', revision: 4, schema: {type: 'object', properties: {id: {type: 'string'}, total: {type: 'number'}}}},
    {id: 'profiles', name: 'Profile event', revision: 7, schema: {type: 'object', properties: {name: {type: 'string'}, locale: {type: 'string'}}}},
  ];
}

function resolveRefs(value: unknown): unknown { return value; }

const etagOf = (revision: number) => `"${revision}"`;

export function createApp() {
  const contracts = seedContracts();
  // Full revision history per contract, so a 409 can return the exact baseline
  // the stale client started editing from.
  const history = new Map<string, Map<number, Record<string, unknown>>>();
  const remember = (contract: Contract) => {
    let revisions = history.get(contract.id);
    if (!revisions) history.set(contract.id, (revisions = new Map()));
    revisions.set(contract.revision, clone(contract.schema));
  };
  contracts.forEach(remember);

  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => res.json({kind: 'contract', count: contracts.length}));
  app.get('/api/contracts', (_req, res) => res.json(contracts.map(({id, name, revision}) => ({id, name, revision}))));
  app.get('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    res.set('ETag', etagOf(contract.revision)).json(contract);
  });
  app.get('/api/contracts/:id/revisions/:rev', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    const revision = Number(req.params.rev);
    const schema = history.get(contract.id)?.get(revision);
    if (!schema) return res.status(404).json({error: 'revision_not_found'});
    res.json({id: contract.id, revision, schema});
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
  app.put('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});

    // Conditional update on the strong revision ETag.
    const ifMatch = req.get('If-Match');
    if (!ifMatch) {
      return res.status(428).json({error: 'precondition_required', message: 'If-Match header carrying the base revision ETag is required'});
    }
    if (/^\s*W\//.test(ifMatch)) {
      return res.status(400).json({error: 'weak_etag_not_allowed', message: 'Conditional updates require a strong ETag'});
    }
    const match = /^\s*"?(\d+)"?\s*$/.exec(ifMatch);
    if (!match) return res.status(400).json({error: 'invalid_if_match'});
    const baseRevision = Number(match[1]);

    const schema = req.body?.schema as unknown;
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
      return res.status(400).json({error: 'invalid_schema'});
    }

    if (baseRevision !== contract.revision) {
      const baseSchema = history.get(contract.id)?.get(baseRevision);
      const latest = {revision: contract.revision, schema: contract.schema};
      res.set('ETag', etagOf(contract.revision));
      if (!baseSchema) {
        // Baseline no longer known: the client cannot auto-merge.
        return res.status(409).json({error: 'revision_conflict', contractId: contract.id, baseRevision, base: null, latest, conflicts: null});
      }
      const {conflicts} = threeWayMerge(baseSchema, schema, contract.schema);
      return res.status(409).json({
        error: 'revision_conflict',
        contractId: contract.id,
        baseRevision,
        base: {revision: baseRevision, schema: baseSchema},
        latest,
        conflicts: conflicts.map(serializeConflict),
      });
    }

    contract.schema = schema as Record<string, unknown>;
    contract.revision += 1;
    remember(contract);
    res.set('ETag', etagOf(contract.revision)).json(contract);
  });
  app.post('/api/contracts/:id/validate-all', (_req, res) => res.json({results: [{id: 'sample-1', valid: true}]}));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
