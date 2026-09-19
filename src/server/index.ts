import express from 'express';
import {fileURLToPath} from 'node:url';

type Contract = {id: string; name: string; revision: number; schema: Record<string, unknown>};
const contracts: Contract[] = [
  {id: 'orders', name: 'Order event', revision: 4, schema: {type: 'object', properties: {id: {type: 'string'}, total: {type: 'number'}}}},
  {id: 'profiles', name: 'Profile event', revision: 7, schema: {type: 'object', properties: {name: {type: 'string'}, locale: {type: 'string'}}}},
];

function resolveRefs(value: unknown): unknown { return value; }

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.get('/api/bootstrap', (_req, res) => res.json({kind: 'contract', count: contracts.length}));
  app.get('/api/contracts', (_req, res) => res.json(contracts.map(({id, name, revision}) => ({id, name, revision}))));
  app.get('/api/contracts/:id', (req, res) => {
    const contract = contracts.find(item => item.id === req.params.id);
    if (!contract) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(contract.revision)).json(contract);
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
    contract.schema = req.body.schema;
    contract.revision += 1;
    res.json(contract);
  });
  app.post('/api/contracts/:id/validate-all', (_req, res) => res.json({results: [{id: 'sample-1', valid: true}]}));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
