process.env.NODE_ENV = 'test';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const request = require('supertest');
const server = require('../src/server');

describe('Health endpoint', () => {
  afterAll((done) => {
    server.close(done);
  });

  it('returns API health status', async () => {
    const response = await request(server).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'OK');
    expect(response.body).toHaveProperty('services.push.enabled', false);
  });
});
