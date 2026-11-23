import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const hash = text => createHash('sha256').update(text).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const integer = (value, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, '数值超出范围');
  return value;
};
const passwordHash = async password => {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256) fail(400, '密码长度为 10–256 字符');
  const salt = secret();
  return salt + ':' + (await derive(password, salt, 64)).toString('hex');
};
const verifyPassword = async (password, stored) => {
  const [salt, digest] = stored.split(':');
  const actual = await derive(String(password).slice(0, 256), salt, 64);
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
};

export async function createPortal({ dataDir = process.env.PORTAL_DATA || join(root, 'data'), upstream = process.env.PORTAL_UPSTREAM || 'http://127.0.0.1:3425/v1', bootstrapPassword = process.env.PORTAL_ADMIN_PASSWORD } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'portal.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, role TEXT, balance INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id), expires INTEGER);
    CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), hash TEXT UNIQUE, label TEXT, prefix TEXT, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT,url TEXT,key TEXT,enabled INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,channel_id TEXT REFERENCES channels(id),upstream_model TEXT,input_rate INTEGER DEFAULT 1,output_rate INTEGER DEFAULT 2,request_fee INTEGER DEFAULT 0,enabled INTEGER DEFAULT 0,cache_ttl INTEGER DEFAULT 0,cache_percent INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),idem TEXT,fingerprint TEXT,model TEXT,status TEXT,reserved INTEGER,cost INTEGER DEFAULT 0,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cache_hit INTEGER DEFAULT 0,response TEXT,created INTEGER,UNIQUE(user_id,idem));
    CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),delta INTEGER,reason TEXT,created INTEGER,operation TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS cache(user_id TEXT,key TEXT,response TEXT,expires INTEGER,PRIMARY KEY(user_id,key));`);
  const query = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Interrupted calls retain their reservation for operator reconciliation.
  run("UPDATE requests SET status='uncertain' WHERE status='pending'");
  if (!one("SELECT id FROM users WHERE role='admin'")) {
    const password = bootstrapPassword || secret();
    run('INSERT INTO users(id,email,password,role) VALUES(?,?,?,?)', randomUUID(), 'admin@buddyrelay.local', await passwordHash(password), 'admin');
    writeFileSync(join(dataDir, 'admin-access.txt'), `管理地址 http://127.0.0.1:8787/admin\n账号 admin@buddyrelay.local\n密码 ${password}\n`, { mode: 0o600 });
  }
  run('INSERT OR IGNORE INTO channels(id,name,url,key) VALUES(?,?,?,?)', 'magpie', 'Magpie 统一账号池', upstream.replace(/\/$/, ''), process.env.PORTAL_UPSTREAM_KEY || '');
  const authAttempts = new Map();
  const concurrency = new Map();

  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) fail(413, '请求最大为 1 MB'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail(400, 'JSON 格式错误'); }
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function authenticate(req, sessionOnly = false) {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (!sessionOnly && bearer) {
      const user = one('SELECT u.* FROM users u JOIN api_keys k ON k.user_id=u.id WHERE k.hash=? AND k.revoked=0', hash(bearer));
      if (user && !user.disabled) return user;
    }
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)buddyrelay=([A-Za-z0-9_-]+)/)?.[1];
    const user = cookie && one('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?', hash(cookie), Date.now());
    if (!user || user.disabled) fail(401, '请先登录或提供有效的 API Key');
    return user;
  }
  function ledger(userId, delta, reason, operation = randomUUID()) {
    run('UPDATE users SET balance=balance+? WHERE id=?', delta, userId);
    run('INSERT INTO ledger VALUES(?,?,?,?,?,?)', randomUUID(), userId, delta, reason, Date.now(), operation);
  }
  function costOf(usage, model, hold) {
    if (!Number.isSafeInteger(usage?.prompt_tokens) || usage.prompt_tokens < 0 || !Number.isSafeInteger(usage?.completion_tokens) || usage.completion_tokens < 0) return hold;
    return Math.min(hold, Math.ceil(usage.prompt_tokens * model.input_rate + usage.completion_tokens * model.output_rate + model.request_fee));
  }
  async function refreshModels(channel) {
    const response = await fetch(channel.url + '/models', { headers: { Authorization: 'Bearer ' + (channel.key || 'magpie') }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(502, '上游模型列表读取失败');
    const result = await response.json();
    if (!Array.isArray(result.data)) fail(502, '上游模型列表格式错误');
    transaction(() => {
      for (const model of result.data.slice(0, 5000)) {
        if (typeof model.id !== 'string' || model.id.length > 300) continue;
        run('INSERT OR IGNORE INTO models(id,channel_id,upstream_model) VALUES(?,?,?)', channel.id + '/' + model.id, channel.id, model.id);
      }
    });
    return result.data.length;
  }

  async function completion(req, res, user, input) {
    const model = one('SELECT m.*,c.url,c.key FROM models m JOIN channels c ON c.id=m.channel_id WHERE m.id=? AND m.enabled=1 AND c.enabled=1', input.model || '');
    if (!model) fail(400, '模型未开放，请联系管理员设置价格并启用');
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 100) fail(400, 'messages 格式错误');
    if ((input.n ?? 1) !== 1) fail(400, '每次请求仅支持一条回答');
    if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) fail(400, '随机程度必须在 0–2 之间');
    const maxTokens = integer(input.max_completion_tokens ?? input.max_tokens ?? 1024, 1, 8192);
    const payload = { ...input, model: model.upstream_model, max_tokens: maxTokens, n: 1 };
    delete payload.max_completion_tokens;
    delete payload.cache;
    const wantsStream = payload.stream === true;
    if (wantsStream) payload.stream_options = { include_usage: true };
    const serialized = JSON.stringify(payload);
    const fingerprint = hash(serialized);
    const idem = req.headers['idempotency-key'] || randomUUID();
    if (typeof idem !== 'string' || idem.length > 150) fail(400, 'Idempotency-Key 长度超限');
    const prior = one('SELECT * FROM requests WHERE user_id=? AND idem=?', user.id, idem);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail(409, '此幂等键已用于不同请求');
      if (prior.status !== 'done' || wantsStream || !prior.response) fail(409, '此请求已处理或待确认，请查看调用记录');
      res.setHeader('X-Request-Id', prior.id);
      return json(res, 200, JSON.parse(prior.response));
    }
    const cacheable = input.cache === true && !wantsStream && input.temperature === 0 && !input.tools && !input.functions && model.cache_ttl > 0;
    const cacheKey = hash(model.id + ':' + fingerprint);
    const cached = cacheable && one('SELECT response FROM cache WHERE user_id=? AND key=? AND expires>?', user.id, cacheKey, Date.now());
    const maximum = Math.ceil(Buffer.byteLength(serialized) * model.input_rate + maxTokens * model.output_rate + model.request_fee);
    const hold = cached ? Math.ceil(model.request_fee * model.cache_percent / 100) : maximum;
    const id = randomUUID();
    transaction(() => {
      const changed = run('UPDATE users SET balance=balance-? WHERE id=? AND disabled=0 AND balance>=?', hold, user.id, hold);
      if (!changed.changes) fail(402, '积分不足，请联系管理员充值');
      run('INSERT INTO requests(id,user_id,idem,fingerprint,model,status,reserved,created) VALUES(?,?,?,?,?,?,?,?)', id, user.id, idem, fingerprint, model.id, 'pending', hold, Date.now());
    });
    res.setHeader('X-Request-Id', id);
    const finish = (cost, usage, response, status, hit = false) => transaction(() => {
      const row = one('SELECT status FROM requests WHERE id=?', id);
      if (row.status !== 'pending') return;
      run('UPDATE users SET balance=balance+? WHERE id=?', hold - cost, user.id);
      run('UPDATE requests SET status=?,cost=?,input_tokens=?,output_tokens=?,cache_hit=?,response=? WHERE id=?', status, cost, usage?.prompt_tokens || 0, usage?.completion_tokens || 0, hit ? 1 : 0, response, id);
      run('INSERT INTO ledger VALUES(?,?,?,?,?,?)', randomUUID(), user.id, -cost, status === 'done' ? '模型调用 ' + model.id : '调用失败，退回预扣积分', Date.now(), id);
    });
    if (cached) {
      finish(hold, {}, cached.response, 'done', true);
      res.setHeader('X-Cache', 'HIT');
      return json(res, 200, JSON.parse(cached.response));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let delivered = false;
    let usage;
    try {
      const response = await fetch(model.url + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (model.key || 'magpie') }, body: serialized, signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); fail(502, '上游调用失败，预扣积分已退回'); }
      let output = '';
      if (wantsStream) {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) fail(502, '上游未返回流式响应');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        const decoder = new TextDecoder();
        let pending = '';
        let size = 0;
        let done = false;
        for await (const chunk of response.body) {
          delivered = true;
          size += chunk.length;
          if (size > 16 * 1024 * 1024) fail(502, '上游响应过大');
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines.slice(0, -1)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') done = true;
            else { try { const event = JSON.parse(data); if (event.usage) usage = event.usage; } catch {} }
          }
          if (!res.write(chunk)) await new Promise((resolve, reject) => {
            const drained = () => { res.off('close', closed); resolve(); };
            const closed = () => { res.off('drain', drained); reject(new Error('Client disconnected')); };
            res.once('drain', drained);
            res.once('close', closed);
          });
        }
        if (!done) fail(502, '上游流式连接中断');
        const cost = costOf(usage, model, hold);
        finish(cost, usage, null, 'done');
        res.end();
      } else {
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) fail(502, '上游响应过大'); chunks.push(chunk); }
        const result = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(result.choices) || result.error) fail(502, '上游回答格式错误');
        result.model = model.id;
        usage = result.usage;
        const cost = costOf(usage, model, hold);
        output = JSON.stringify(result);
        finish(cost, usage, output, 'done');
        if (cacheable) run('INSERT OR REPLACE INTO cache VALUES(?,?,?,?)', user.id, cacheKey, output, Date.now() + model.cache_ttl * 1000);
        res.setHeader('X-Cache', 'MISS');
        json(res, 200, result);
      }
    } catch (error) {
      finish(delivered ? hold : 0, usage, null, delivered ? 'uncertain' : 'failed');
      if (res.headersSent) res.end('data: ' + JSON.stringify({ error: { message: '连接中断，请查看调用记录' } }) + '\n\n');
      else throw error.status ? error : Object.assign(new Error('上游暂时不可用，预扣积分已退回'), { status: 502 });
    } finally { clearTimeout(timer); }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://' + req.headers.host);
      const path = url.pathname;
      if (req.method === 'GET' && ['/','/admin','/app.js','/style.css'].includes(path)) {
        const file = path.endsWith('.js') ? 'app.js' : path.endsWith('.css') ? 'style.css' : 'index.html';
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
        res.end(readFileSync(join(root, 'public', file))); return;
      }
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (req.headers['content-length'] && Number(req.headers['content-length']) > 1024 * 1024) fail(413, '请求最大为 1 MB');
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) fail(403, '跨站请求被拒绝');
      if (req.method === 'POST' && ['/api/login','/api/register'].includes(path)) {
        const ip = req.socket.remoteAddress;
        const attempt = authAttempts.get(ip) || { count: 0, until: Date.now() + 60000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60000; }
        if (++attempt.count > 15) fail(429, '尝试次数过多，请稍后重试');
        authAttempts.set(ip, attempt);
        const input = await body(req);
        const email = String(input.email || '').trim().toLowerCase();
        if (!/^[^\s@]{1,80}@[^\s@]{1,120}\.[^\s@]{1,20}$/.test(email)) fail(400, '请输入有效邮箱');
        let user = one('SELECT * FROM users WHERE email=?', email);
        if (path === '/api/register') {
          if (user) fail(409, '该邮箱已注册');
          const digest = await passwordHash(input.password);
          try { run('INSERT INTO users(id,email,password,role) VALUES(?,?,?,?)', randomUUID(), email, digest, 'user'); } catch { fail(409, '该邮箱已注册'); }
          user = one('SELECT * FROM users WHERE email=?', email);
        } else if (!user || !await verifyPassword(input.password, user.password) || user.disabled) fail(401, '邮箱或密码错误');
        user = one('SELECT * FROM users WHERE id=?', user.id);
        if (user.disabled) fail(401, '账户已停用');
        const token = secret();
        run('INSERT INTO sessions VALUES(?,?,?)', hash(token), user.id, Date.now() + 86400000);
        const secure = process.env.PORTAL_SECURE_COOKIE === '1' ? '; Secure' : '';
        res.setHeader('Set-Cookie', 'buddyrelay=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' + secure);
        return json(res, 200, { ok: true });
      }
      const isAdmin = path.startsWith('/api/admin');
      const user = authenticate(req, isAdmin || !path.startsWith('/v1/'));
      if (isAdmin && user.role !== 'admin') fail(403, '需要管理员权限');
      const input = req.method === 'POST' ? await body(req) : {};
      if (path === '/api/logout' && req.method === 'POST') {
        const cookie = req.headers.cookie?.match(/buddyrelay=([A-Za-z0-9_-]+)/)?.[1];
        if (cookie) run('DELETE FROM sessions WHERE hash=?', hash(cookie));
        res.setHeader('Set-Cookie', 'buddyrelay=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/password' && req.method === 'POST') {
        if (!await verifyPassword(input.current, user.password)) fail(400, '原密码错误');
        const digest = await passwordHash(input.password);
        transaction(() => { run('UPDATE users SET password=? WHERE id=?', digest, user.id); run('DELETE FROM sessions WHERE user_id=?', user.id); });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/me') return json(res, 200, { id: user.id, email: user.email, role: user.role, balance: user.balance / 1000 });
      if (path === '/v1/models' || path === '/api/models') return json(res, 200, { object: 'list', data: query('SELECT m.id,m.input_rate,m.output_rate,m.request_fee,m.cache_ttl,m.cache_percent FROM models m JOIN channels c ON c.id=m.channel_id WHERE m.enabled=1 AND c.enabled=1').map(m => ({ ...m, object: 'model', request_fee: m.request_fee / 1000 })) });
      if (path === '/api/usage') return json(res, 200, { requests: query('SELECT id,model,status,cost,input_tokens,output_tokens,cache_hit,created FROM requests WHERE user_id=? ORDER BY created DESC LIMIT 100', user.id), ledger: query('SELECT delta,reason,created FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 100', user.id) });
      if (path === '/api/keys' && req.method === 'POST') {
        if (one('SELECT count(*) AS n FROM api_keys WHERE user_id=? AND revoked=0', user.id).n >= 20) fail(400, '最多创建 20 个有效密钥');
        const key = 'sk-br-' + secret();
        run('INSERT INTO api_keys(id,user_id,hash,label,prefix) VALUES(?,?,?,?,?)', randomUUID(), user.id, hash(key), String(input.label || 'API Key').slice(0, 80), key.slice(0, 12));
        return json(res, 200, { key });
      }
      if (path === '/api/keys') return json(res, 200, query('SELECT id,label,prefix,revoked FROM api_keys WHERE user_id=?', user.id));
      if (path === '/api/keys/revoke' && req.method === 'POST') { run('UPDATE api_keys SET revoked=1 WHERE id=? AND user_id=?', input.id || '', user.id); return json(res, 200, { ok: true }); }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        if ((concurrency.get(user.id) || 0) >= 3) fail(429, '每个用户最多同时进行 3 个请求');
        concurrency.set(user.id, (concurrency.get(user.id) || 0) + 1);
        try { await completion(req, res, user, input); } finally { concurrency.set(user.id, concurrency.get(user.id) - 1); }
        return;
      }
      if (path === '/api/admin/state') return json(res, 200, { users: query('SELECT id,email,role,balance,disabled FROM users'), channels: query('SELECT id,name,url,enabled FROM channels'), models: query('SELECT * FROM models'), uncertain: query("SELECT id,user_id,model,reserved,created FROM requests WHERE status='uncertain'") });
      if (path === '/api/admin/credit' && req.method === 'POST') {
        const delta = integer(Math.round(Number(input.points) * 1000), -1e12, 1e12);
        if (!one('SELECT id FROM users WHERE id=?', input.id || '')) fail(404, '用户不存在');
        const operation = String(input.operation || '');
        if (!operation || operation.length > 150) fail(400, '缺少充值操作编号');
        transaction(() => {
          if (one('SELECT id FROM ledger WHERE operation=?', operation)) return;
          if (one('SELECT balance FROM users WHERE id=?', input.id).balance + delta < 0) fail(400, '扣除后积分不能为负');
          ledger(input.id, delta, '管理员调整积分', operation);
        });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/admin/user' && req.method === 'POST') {
        if (input.id === user.id) fail(400, '不能停用当前管理员');
        run('UPDATE users SET disabled=? WHERE id=?', input.disabled ? 1 : 0, input.id || '');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/admin/model' && req.method === 'POST') {
        const inputRate = integer(Number(input.input_rate), 0, 1000000);
        const outputRate = integer(Number(input.output_rate), 0, 1000000);
        const fee = integer(Math.round(Number(input.request_fee) * 1000), 0, 1e9);
        run('UPDATE models SET input_rate=?,output_rate=?,request_fee=?,enabled=?,cache_ttl=?,cache_percent=? WHERE id=?', inputRate, outputRate, fee, input.enabled ? 1 : 0, integer(Number(input.cache_ttl), 0, 86400), integer(Number(input.cache_percent), 0, 100), input.id || '');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/admin/channel' && req.method === 'POST') {
        const u = new URL(input.url);
        if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail(400, '请输入有效上游地址');
        const id = String(input.id || randomUUID());
        const old = one('SELECT * FROM channels WHERE id=?', id);
        run('INSERT INTO channels VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,key=excluded.key,enabled=excluded.enabled', id, String(input.name || '上游账号').slice(0, 80), input.url.replace(/\/$/, ''), input.key || old?.key || '', input.enabled === false ? 0 : 1);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/admin/sync' && req.method === 'POST') {
        let count = 0;
        const errors = [];
        for (const channel of query('SELECT * FROM channels WHERE enabled=1')) {
          try { count += await refreshModels(channel); } catch { errors.push(channel.name + ' 暂不可用'); }
        }
        return json(res, 200, { count, errors });
      }
      if (path === '/api/admin/accounts/import' && req.method === 'POST') {
        if (!Array.isArray(input.accounts) || !input.accounts.length || input.accounts.length > 200) fail(400, '请提供最多 200 个账号的数组');
        const response = await fetch((process.env.PORTAL_ACCOUNT_API || 'http://127.0.0.1:57890') + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.PORTAL_ACCOUNT_TOKEN || '') }, body: JSON.stringify({ fileText: JSON.stringify(input.accounts), indexes: input.accounts.map((_, i) => i) }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) fail(502, '账号管理服务拒绝导入，请检查后台连接');
        const result = await response.json();
        return json(res, 200, { imported: result.imported, skipped: result.skipped });
      }
      if (path === '/api/admin/reconcile' && req.method === 'POST') {
        transaction(() => {
          const item = one("SELECT * FROM requests WHERE id=? AND status='uncertain'", input.id || '');
          if (!item) fail(409, '此记录已处理');
          const charge = integer(Math.round(Number(input.points) * 1000), 0, item.reserved);
          const refund = item.cost ? item.cost - charge : item.reserved - charge;
          ledger(item.user_id, refund, '中断调用人工核对', 'reconcile-' + item.id);
          run("UPDATE requests SET status='reconciled',cost=? WHERE id=?", charge, item.id);
        });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/admin/cache/clear' && req.method === 'POST') { run('DELETE FROM cache'); return json(res, 200, { ok: true }); }
      fail(404, '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error.status || 500, { error: { message: error.status ? error.message : '服务暂时不可用，请检查后台连接', type: 'relay_error' } });
    }
  });
  const cleanup = setInterval(() => { run('DELETE FROM sessions WHERE expires<?', Date.now()); run('DELETE FROM cache WHERE expires<?', Date.now()); authAttempts.clear(); }, 600000);
  cleanup.unref();
  let syncing = false;
  const sync = setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try { for (const channel of query('SELECT * FROM channels WHERE enabled=1')) { try { await refreshModels(channel); } catch {} } }
    finally { syncing = false; }
  }, 60000);
  sync.unref();
  server.on('close', () => { clearInterval(cleanup); clearInterval(sync); db.close(); });
  return { server, db, refreshModels };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createPortal();
  const host = process.env.PORTAL_HOST || '127.0.0.1';
  const port = Number(process.env.PORTAL_PORT || 8787);
  server.listen(port, host, () => console.log(`BuddyRelay portal http://${host}:${port}\nAdmin credentials are stored in portal/data/admin-access.txt`));
}
