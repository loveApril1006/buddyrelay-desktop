import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPortal } from './server.mjs';

test('用户隔离、预扣结算、缓存、流式、失败退款和密钥撤销', async t => {
  let hits = 0;
  let broken = false;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    hits++;
    if (broken) { res.writeHead(503); res.end('{}'); return; }
    let raw = '';
    for await (const part of req) raw += part;
    const input = JSON.parse(raw);
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (input.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.end('data: ' + JSON.stringify({ choices: [], usage }) + '\n\ndata: [DONE]\n\n');
    } else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }], usage }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = mkdtempSync(join(tmpdir(), 'buddyrelay-portal-test-'));
  const { server, db } = await createPortal({ dataDir, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, bootstrapPassword: 'integration-test-password' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dataDir, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, body, cookie, extra = {}) {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { res, data };
  }
  const login = await call('/api/login', { email: 'admin@buddyrelay.local', password: 'integration-test-password' });
  assert.equal(login.res.status, 200);
  const admin = login.res.headers.get('set-cookie').split(';')[0];
  const a = await call('/api/register', { email: 'alice@example.com', password: 'test-user-password' });
  const alice = a.res.headers.get('set-cookie').split(';')[0];
  const b = await call('/api/register', { email: 'bob@example.com', password: 'test-user-password' });
  const bob = b.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/admin/state', undefined, alice)).res.status, 403);
  const aliceMe = (await call('/api/me', undefined, alice)).data;
  const bobMe = (await call('/api/me', undefined, bob)).data;
  for (const id of [aliceMe.id, bobMe.id]) {
    assert.equal((await call('/api/admin/credit', { id, points: 100, operation: 'grant-' + id }, admin)).res.status, 200);
    await call('/api/admin/credit', { id, points: 100, operation: 'grant-' + id }, admin);
  }
  assert.equal((await call('/api/me', undefined, alice)).data.balance, 100);
  await call('/api/admin/sync', {}, admin);
  assert.equal((await call('/api/models', undefined, alice)).data.data.length, 0);
  const model = 'magpie/test-model';
  assert.equal((await call('/api/admin/model', { id: model, input_rate: 1, output_rate: 2, request_fee: 1, enabled: true, cache_ttl: 60, cache_percent: 10 }, admin)).res.status, 200);
  const input = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, temperature: 0, cache: true };
  const result = await call('/v1/chat/completions', input, alice, { 'Idempotency-Key': 'same-call' });
  assert.equal(result.res.status, 200);
  assert.equal((await call('/api/me', undefined, alice)).data.balance, 98.98);
  await call('/v1/chat/completions', input, alice, { 'Idempotency-Key': 'same-call' });
  assert.equal(hits, 1);
  const cache = await call('/v1/chat/completions', input, alice);
  assert.equal(cache.res.headers.get('x-cache'), 'HIT');
  assert.equal((await call('/api/me', undefined, alice)).data.balance, 98.88);
  await call('/v1/chat/completions', input, bob);
  assert.equal(hits, 2, 'Bob must not receive Alice response cache');
  const stream = await call('/v1/chat/completions', { ...input, stream: true, cache: false }, alice);
  assert.equal(stream.res.status, 200);
  assert.match(stream.data, /\[DONE\]/);
  assert.equal((await call('/api/me', undefined, alice)).data.balance, 97.86);
  broken = true;
  assert.equal((await call('/v1/chat/completions', { ...input, cache: false }, alice)).res.status, 502);
  assert.equal((await call('/api/me', undefined, alice)).data.balance, 97.86);
  const key = (await call('/api/keys', { label: 'test' }, alice)).data.key;
  assert.equal((await call('/v1/models', undefined, null, { Authorization: 'Bearer ' + key })).res.status, 200);
  const keyId = (await call('/api/keys', undefined, alice)).data[0].id;
  await call('/api/keys/revoke', { id: keyId }, bob);
  assert.equal((await call('/v1/models', undefined, null, { Authorization: 'Bearer ' + key })).res.status, 200);
  await call('/api/keys/revoke', { id: keyId }, alice);
  assert.equal((await call('/v1/models', undefined, null, { Authorization: 'Bearer ' + key })).res.status, 401);
  db.prepare('UPDATE users SET balance=1 WHERE id=?').run(aliceMe.id);
  assert.equal((await call('/v1/chat/completions', { ...input, cache: false }, alice)).res.status, 402);
});
