import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';

const port = 31_000 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('..', import.meta.url));
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {...process.env, PORT: String(port), GROQ_API_KEY: 'your_test_placeholder'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await Promise.race([
    once(server.stdout, 'data'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not start')), 5_000))
  ]);
});

after(() => server.kill());

test('health exposes safe configuration state only', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.environmentLoaded, true);
  assert.equal(body.credentialPlaceholder, true);
  assert.equal(body.providerReady, false);
  assert.equal('key' in body, false);
  assert.equal('apiKey' in body, false);
  assert.equal(body.models.text.id, 'qwen/qwen3.8-27b');
});

test('frontend is served with security headers', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /Kyro Pro/);
});

test('chat route refuses placeholder credentials', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: 'hello'}]})
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error.message, /not configured/i);
});

test('chat route validates malformed history before provider access', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: {bad: true}}]})
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error.message, /invalid message history/i);
});
