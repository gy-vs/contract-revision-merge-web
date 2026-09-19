import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('contract-revision-merge-web', () => {
  it('serves its bootstrap contract', async () => {
    const response = await request(createApp()).get('/api/bootstrap');
    expect(response.status).toBe(200);
    expect(response.body.kind).toBe('contract');
    expect(response.body.count).toBeTypeOf('number');
  });
});
