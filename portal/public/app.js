const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const points = milli => (milli / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const date = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false });
let registering = false;
let me;
let models = [];
let history = [];
let adminState;
let adminTab = 'users';

async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || '请求失败');
  return data;
}
function notice(message, error = false) {
  $('#notice').hidden = false;
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}
async function action(button, fn) {
  button.disabled = true;
  try { await fn(); } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
async function balance() {
  me = await api('/api/me');
  $('#balance').textContent = me.balance.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
async function boot() {
  try {
    await balance();
    $('#auth').hidden = true;
    $('#workspace').hidden = false;
    $('#userEmail').textContent = me.email;
    $('#adminNav').hidden = me.role !== 'admin';
    $('#baseURL').value = location.origin + '/v1';
    await loadModels();
    await navigate(location.pathname === '/admin' && me.role === 'admin' ? 'admin' : 'chat');
  } catch {
    $('#auth').hidden = false;
    $('#workspace').hidden = true;
  }
}
$('#toggleAuth').onclick = () => {
  registering = !registering;
  $('#authTitle').textContent = registering ? '创建账户' : '登录工作台';
  $('#authSubmit').textContent = registering ? '注册' : '登录';
  $('#toggleAuth').textContent = registering ? '已有账户？登录' : '还没有账户？注册';
  $('#authError').textContent = '';
};
$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  const button = $('#authSubmit');
  button.disabled = true;
  try {
    await api(registering ? '/api/register' : '/api/login', Object.fromEntries(new FormData(event.target)));
    await boot();
  } catch (error) { $('#authError').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#logout').onclick = () => action($('#logout'), async () => { await api('/api/logout', {}); location.reload(); });
const titles = { chat: '对话工作台', models: '模型与价格', keys: 'API 密钥', usage: '用量与账单', account: '账户设置', admin: '管理后台' };
async function navigate(view) {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== 'view-' + view;
  for (const button of document.querySelectorAll('#nav button')) button.classList.toggle('active', button.dataset.view === view);
  $('#pageTitle').textContent = titles[view];
  $('#notice').hidden = true;
  if (view === 'keys') await loadKeys();
  if (view === 'usage') await loadUsage();
  if (view === 'models') await loadModels();
  if (view === 'admin') { adminState = await api('/api/admin/state'); renderAdmin(); }
}
$('#nav').onclick = event => {
  const button = event.target.closest('[data-view]');
  if (button) action(button, () => navigate(button.dataset.view));
};
async function loadModels() {
  models = (await api('/api/models')).data;
  const selected = $('#chatModel').value;
  $('#chatModel').innerHTML = models.length ? models.map(m => `<option value="${escape(m.id)}">${escape(m.id)}</option>`).join('') : '<option value="">管理员尚未开放模型</option>';
  if (models.some(m => m.id === selected)) $('#chatModel').value = selected;
  $('#modelCards').innerHTML = models.length ? models.map(m => `<article class="card model-card"><h3>${escape(m.id)}</h3><div class="prices"><div><span class="muted">输入 / 千 Token</span><strong>${m.input_rate}</strong></div><div><span class="muted">输出 / 千 Token</span><strong>${m.output_rate}</strong></div></div><p class="muted">按次 ${m.request_fee} 积分 · ${m.cache_ttl ? '缓存 ' + m.cache_ttl + ' 秒，命中收取按次费用的 ' + m.cache_percent + '%' : '未启用回答缓存'}</p><button class="secondary" data-copy-model="${escape(m.id)}">复制模型 ID</button></article>`).join('') : '<div class="card empty-small">模型尚未开放，请联系管理员配置上游和价格。</div>';
  $('#send').disabled = !models.length;
  priceHint();
}
$('#modelCards').onclick = event => {
  const button = event.target.closest('[data-copy-model]');
  if (button) action(button, async () => { await navigator.clipboard.writeText(button.dataset.copyModel); notice('模型 ID 已复制'); });
};
function priceHint() {
  const model = models.find(m => m.id === $('#chatModel').value);
  $('#priceHint').textContent = model ? `输入 ${model.input_rate} / 输出 ${model.output_rate} 积分每千 Token` : '等待管理员开放模型';
}
$('#chatModel').onchange = priceHint;
function addMessage(role, text, error = false) {
  $('#messages .empty')?.remove();
  const node = document.createElement('article');
  node.className = 'message ' + role + (error ? ' error' : '');
  const by = document.createElement('div');
  by.className = 'by';
  by.textContent = role === 'user' ? '你' : '模型回答';
  const pre = document.createElement('pre');
  pre.textContent = text;
  node.append(by, pre);
  $('#messages').append(node);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return pre;
}
$('#newChat').onclick = () => { history = []; $('#messages').replaceChildren(); };
$('#chatForm').onsubmit = async event => {
  event.preventDefault();
  if (!$('#prompt').value.trim()) return;
  await action($('#send'), async () => {
    const prompt = $('#prompt').value.trim();
    const messages = [...history, { role: 'user', content: prompt }];
    addMessage('user', prompt);
    $('#prompt').value = '';
    const answer = addMessage('assistant', '正在连接模型…');
    let text = '';
    try {
      const stream = $('#stream').checked;
      const response = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ model: $('#chatModel').value, messages, max_tokens: Number($('#maxTokens').value), temperature: Number($('#temperature').value), cache: $('#cache').checked, stream }) });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message || '调用失败'); }
      if (stream) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          buffer += decoder.decode(part.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (raw === '[DONE]') { done = true; continue; }
            const data = JSON.parse(raw);
            if (data.error) throw new Error(data.error.message);
            const delta = data.choices?.[0]?.delta;
            text += delta?.content || delta?.reasoning_content || '';
          }
          answer.textContent = text || '模型正在处理…';
          $('#messages').scrollTop = $('#messages').scrollHeight;
        }
        if (!done) throw new Error('回答连接中断，请查看调用记录');
      } else {
        const result = await response.json();
        text = result.choices?.[0]?.message?.content || '模型返回了非文本内容，请使用 API 客户端查看。';
        answer.textContent = text;
        if (response.headers.get('X-Cache') === 'HIT') notice('本次回答命中缓存');
      }
      history = [...messages, { role: 'assistant', content: text }];
    } catch (error) {
      answer.textContent = (text ? text + '\n\n' : '') + error.message;
      answer.closest('article').classList.add('error');
    } finally { await balance(); }
  });
};
async function loadKeys() {
  const keys = await api('/api/keys');
  $('#keyList').innerHTML = keys.length ? keys.map(k => `<div class="list-row"><div>${escape(k.label)}<small>${escape(k.prefix)}… · ${k.revoked ? '已撤销' : '有效'}</small></div>${k.revoked ? '' : `<button class="secondary" data-revoke="${escape(k.id)}">撤销</button>`}</div>`).join('') : '<p class="empty-small">还没有 API 密钥。创建后可在支持 OpenAI API 的客户端使用。</p>';
}
$('#keyForm').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => { const result = await api('/api/keys', Object.fromEntries(new FormData(event.target))); $('#newKey').textContent = result.key; $('#keyReveal').hidden = false; await loadKeys(); }); };
$('#copyKey').onclick = () => action($('#copyKey'), async () => { await navigator.clipboard.writeText($('#newKey').textContent); notice('密钥已复制'); });
$('#keyList').onclick = event => { const b = event.target.closest('[data-revoke]'); if (b) action(b, async () => { await api('/api/keys/revoke', { id: b.dataset.revoke }); await loadKeys(); }); };
const states = { done: '已完成', failed: '已退款', pending: '进行中', uncertain: '待核对', reconciled: '已核对' };
async function loadUsage() {
  const result = await api('/api/usage');
  $('#usageRows').innerHTML = result.requests.length ? result.requests.map(r => `<tr><td>${date(r.created)}</td><td>${escape(r.model)}</td><td>${r.input_tokens} / ${r.output_tokens}</td><td>${points(r.cost)}</td><td>${states[r.status] || escape(r.status)}${r.cache_hit ? ' · 缓存' : ''}</td></tr>`).join('') : '<tr><td colspan="5">还没有调用记录</td></tr>';
  $('#ledgerRows').innerHTML = result.ledger.length ? result.ledger.map(r => `<div class="list-row"><div>${escape(r.reason)}<small>${date(r.created)}</small></div><strong>${r.delta > 0 ? '+' : ''}${points(r.delta)}</strong></div>`).join('') : '<p class="empty-small">还没有积分流水</p>';
}
$('#passwordForm').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => { await api('/api/password', Object.fromEntries(new FormData(event.target))); location.reload(); }); };
$('.admin-tabs').onclick = event => { const button = event.target.closest('[data-admin]'); if (button) { adminTab = button.dataset.admin; renderAdmin(); } };
function renderAdmin() {
  for (const b of document.querySelectorAll('[data-admin]')) b.classList.toggle('active', b.dataset.admin === adminTab);
  const area = $('#adminContent');
  if (adminTab === 'users') area.innerHTML = `<div class="card"><h2>用户与积分</h2><p class="muted">输入正数充值，负数扣减。每次操作会写入用户的积分流水。</p><div class="table-scroll"><table><thead><tr><th>用户</th><th>余额</th><th>调整积分</th><th>操作</th></tr></thead><tbody>${adminState.users.map(u => `<tr><td>${escape(u.email)}<small class="muted"> ${u.role === 'admin' ? '管理员' : u.disabled ? '已停用' : ''}</small></td><td>${points(u.balance)}</td><td><input class="price-edit" type="number" step="0.001" data-credit-input="${escape(u.id)}" placeholder="100"></td><td><button class="secondary" data-credit="${escape(u.id)}">调整</button> ${u.id === me.id ? '' : `<button class="text-button" data-disable="${escape(u.id)}" data-value="${u.disabled ? 0 : 1}">${u.disabled ? '启用' : '停用'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (adminTab === 'models') area.innerHTML = `<div class="card"><div class="list-row"><h2>模型定价</h2><button id="syncModels" class="primary">同步上游模型</button></div><p class="muted">输入与输出价格为积分 / 千 Token。新同步的模型需要设置价格并启用。缓存命中只收按次费用 × 缓存收费比例。</p><div class="table-scroll"><table><thead><tr><th>模型</th><th>输入价格</th><th>输出价格</th><th>按次积分</th><th>缓存秒数</th><th>缓存收费 %</th><th>开放</th><th></th></tr></thead><tbody>${adminState.models.map(m => `<tr data-model-row="${escape(m.id)}"><td>${escape(m.id)}</td>${['input_rate','output_rate','request_fee','cache_ttl','cache_percent'].map(k => `<td><input class="price-edit small" name="${k}" type="number" min="0" step="${k === 'request_fee' ? '.001' : '1'}" value="${k === 'request_fee' ? m[k] / 1000 : m[k]}"></td>`).join('')}<td><input type="checkbox" name="enabled" ${m.enabled ? 'checked' : ''}></td><td><button class="secondary" data-save-model="${escape(m.id)}">保存</button></td></tr>`).join('')}</tbody></table></div></div>`;
  if (adminTab === 'sources') area.innerHTML = `<div class="card"><h2>上游来源</h2><p class="muted">Magpie 统一入口复用现有 WorkBuddy 账号池。也可接入其他 OpenAI 兼容来源，密钥仅在后台保存。</p>${adminState.channels.map(c => `<div class="list-row"><div>${escape(c.name)}<small>${escape(c.url)} · ${c.enabled ? '已启用' : '已停用'}</small></div><button class="secondary" data-edit-channel="${escape(c.id)}">编辑</button></div>`).join('')}<form id="channelForm" class="admin-form"><input name="id" type="hidden"><label>来源名称<input name="name" required></label><label>OpenAI Base URL<input name="url" type="url" placeholder="http://127.0.0.1:7863/v1" required></label><label>API Key<input name="key" type="password" autocomplete="off" placeholder="留空保留原密钥"></label><label class="check"><input name="enabled" type="checkbox" checked>启用</label><button class="primary">保存来源</button></form></div><form id="importForm" class="card"><h2>批量导入 WorkBuddy 账号</h2><p class="muted">使用 WorkBuddy 导出的账号 JSON 数组，由本机账号管理服务按 UID 合并。导入后在 WorkBuddy 管理中启用对应版本反代，并从 Magpie 接入该反代。</p><label>账号文件<input id="accountsFile" type="file" accept=".json,application/json"></label><label>账号 JSON<textarea name="accounts" class="accounts" placeholder='[{"uid":"...","access_token":"..."}]' required></textarea></label><button class="primary">导入账号</button></form>`;
  if (adminTab === 'ops') area.innerHTML = `<div class="card"><h2>回答缓存</h2><p class="muted">缓存按用户隔离，受每个模型的有效期控制。仅缓存用户主动开启、temperature 为 0 的非流式文本请求。</p><button id="clearCache" class="secondary">清空回答缓存</button></div><div class="card"><h2>中断调用核对</h2><p class="muted">流式输出中断或服务意外退出的请求保留预扣积分，核对后输入最终收费。重复提交不会重复退款。</p>${adminState.uncertain.length ? adminState.uncertain.map(r => `<div class="list-row"><div>${escape(adminState.users.find(u => u.id === r.user_id)?.email)}<small>${escape(r.model)} · 预扣 ${points(r.reserved)} 积分 · ${date(r.created)}</small></div><input class="price-edit" type="number" min="0" step=".001" value="0" data-reconcile-input="${escape(r.id)}"><button class="secondary" data-reconcile="${escape(r.id)}">核对结算</button></div>`).join('') : '<p class="empty-small">当前没有待核对记录</p>'}</div>`;
}
async function refreshAdmin() { adminState = await api('/api/admin/state'); renderAdmin(); await balance(); }
$('#adminContent').onclick = event => {
  const b = event.target.closest('button');
  if (!b) return;
  if (b.id === 'syncModels') action(b, async () => { const result = await api('/api/admin/sync', {}); await refreshAdmin(); notice(`同步完成，共发现 ${result.count} 个模型。` + result.errors.join('，'), !!result.errors.length); });
  if (b.dataset.credit) action(b, async () => { const node = [...document.querySelectorAll('[data-credit-input]')].find(n => n.dataset.creditInput === b.dataset.credit); await api('/api/admin/credit', { id: b.dataset.credit, points: Number(node.value), operation: b.dataset.operation ||= crypto.randomUUID() }); await refreshAdmin(); notice('积分已调整'); });
  if (b.dataset.disable) action(b, async () => { await api('/api/admin/user', { id: b.dataset.disable, disabled: b.dataset.value === '1' }); await refreshAdmin(); });
  if (b.dataset.saveModel) action(b, async () => { const row = b.closest('tr'); const input = { id: b.dataset.saveModel }; for (const n of row.querySelectorAll('input')) input[n.name] = n.type === 'checkbox' ? n.checked : Number(n.value); await api('/api/admin/model', input); await refreshAdmin(); await loadModels(); notice('模型设置已保存'); });
  if (b.dataset.editChannel) { const c = adminState.channels.find(c => c.id === b.dataset.editChannel); const form = $('#channelForm'); for (const key of ['id','name','url']) form.elements[key].value = c[key]; form.elements.enabled.checked = !!c.enabled; form.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  if (b.id === 'clearCache') action(b, async () => { await api('/api/admin/cache/clear', {}); notice('缓存已清空'); });
  if (b.dataset.reconcile) action(b, async () => { const node = [...document.querySelectorAll('[data-reconcile-input]')].find(n => n.dataset.reconcileInput === b.dataset.reconcile); await api('/api/admin/reconcile', { id: b.dataset.reconcile, points: Number(node.value) }); await refreshAdmin(); notice('核对完成'); });
};
$('#adminContent').onsubmit = event => {
  event.preventDefault();
  if (event.target.id === 'channelForm') action(event.submitter, async () => { const form = event.target; await api('/api/admin/channel', { ...Object.fromEntries(new FormData(form)), enabled: form.elements.enabled.checked }); await refreshAdmin(); notice('来源已保存，请到模型定价页同步模型'); });
  if (event.target.id === 'importForm') action(event.submitter, async () => { const accounts = JSON.parse(event.target.elements.accounts.value); const result = await api('/api/admin/accounts/import', { accounts }); event.target.reset(); notice(`已导入 ${result.imported} 个账号，跳过 ${result.skipped} 个`); });
};
$('#adminContent').onchange = async event => {
  if (event.target.id === 'accountsFile' && event.target.files[0]) {
    const file = event.target.files[0];
    if (file.size > 1024 * 1024) return notice('账号文件最大 1 MB', true);
    $('#importForm').elements.accounts.value = await file.text();
  }
};
await boot();
