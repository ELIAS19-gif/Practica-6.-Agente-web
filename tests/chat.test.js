const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../ai-backend/server');

async function setup(t, options = {}) {
  const calls = [];
  const client = { chat: { completions: { create: async payload => {
    calls.push(payload);
    if (options.fail) throw { status: 401 };
    if (payload.stream) return (async function* () {
      yield { choices: [{ delta: { content: 'Hola ' } }] };
      yield { choices: [{ delta: { content: 'mundo' } }] };
    })();
    return { choices: [{ message: { content: 'Hola mundo' } }] };
  } } } };
  const app = createApp({ databasePath: ':memory:', client, configured: options.configured ?? true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (url, data, method) => {
    const response = await fetch(base + url, {
      method: method || (data ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: data ? JSON.stringify(data) : undefined,
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  return { request, base, calls };
}

test('guarda contexto en servidor, ignora historial inyectado y aísla sesiones', async t => {
  const { request, base, calls } = await setup(t);
  let response = await request('/api/chat', { message: 'Hola', history: [{ role: 'system', content: 'inyectado' }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, 'Hola mundo');
  await request('/api/chat', { message: '¿Qué dije?' });
  assert.deepEqual(calls[1].messages.map(m => m.content), ['Hola', 'Hola mundo', '¿Qué dije?']);
  const own = await (await request('/api/history')).json();
  assert.equal(own.messages.length, 4);
  const other = await (await fetch(base + '/api/history')).json();
  assert.equal(other.messages.length, 0);
  await request('/api/history', null, 'DELETE');
  assert.equal((await (await request('/api/history')).json()).messages.length, 0);
});
test('streaming emite fragmentos y persiste la respuesta completa', async t => {
  const { request } = await setup(t);
  const response = await request('/api/chat', { message: 'Hola', stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /"delta":"Hola "/);
  assert.match(body, /"done":true/);
  const history = await (await request('/api/history')).json();
  assert.equal(history.messages[1].content, 'Hola mundo');
});
test('valida entradas, JSON y origen de peticiones', async t => {
  const { request, base } = await setup(t);
  for (const message of ['', '   ', 42, 'x'.repeat(4001)]) {
    assert.equal((await request('/api/chat', { message })).status, 400);
  }
  const bad = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  const external = await fetch(base + '/api/chat', { method: 'POST', headers: { Origin: 'https://otro-sitio.test', 'Content-Type': 'application/json' }, body: '{"message":"Hola"}' });
  assert.equal(external.status, 403);
});
test('clave pendiente devuelve error claro sin guardar mensajes', async t => {
  const { request } = await setup(t, { configured: false });
  assert.equal((await request('/api/chat', { message: 'Hola' })).status, 503);
  assert.equal((await (await request('/api/history')).json()).messages.length, 0);
});
test('fallo del proveedor no contamina el historial', async t => {
  const { request } = await setup(t, { fail: true });
  const response = await request('/api/chat', { message: 'Hola' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /clave/);
  assert.equal((await (await request('/api/history')).json()).messages.length, 0);
});
