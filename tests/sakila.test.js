const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildQuery, prepareAnswer } = require('../ai-backend/sakila');
test('rechaza SQL libre, filtros inválidos y límites fuera de rango', () => {
  for (const args of [null, { operacion: 'DROP TABLE film' }, { operacion: 'peliculas', sql: 'DELETE FROM film' }, { operacion: 'peliculas', limite: 21 }, { operacion: 'peliculas', limite: '5' }, { operacion: 'peliculas', busqueda: {} }]) assert.throws(() => buildQuery(args));
});
test('parametriza los filtros y escapa comodines de LIKE', () => {
  const attack = "x'; DROP TABLE film; --";
  const query = buildQuery({ operacion: 'peliculas', busqueda: attack, limite: 5 });
  assert.ok(!query.sql.includes(attack));
  assert.equal(query.values[0], `%${attack}%`);
  assert.equal(buildQuery({ operacion: 'peliculas', busqueda: '%_' }).values[0], '%!%!_%');
});
function providerForTool(always = false) {
  let count = 0;
  return { chat: { completions: { create: async () => ({ choices: [{ message: ++count === 1 || always ? { tool_calls: [{ id: `call_${count}`, type: 'function', function: { name: 'consultar_sakila', arguments: '{"operacion":"resumen"}' } }] } : { content: 'Respuesta final' } }] }) } } };
}
test('ejecuta la herramienta y pasa resultados al modelo', async () => {
  let calls = 0;
  const messages = await prepareAnswer({ provider: providerForTool(), model: 'test', messages: [], sakila: { query: async () => { calls++; return { filas: [{ peliculas: 1000 }] }; } } });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(messages.find(m => m.role === 'tool').content).filas, [{ peliculas: 1000 }]);
});
test('un error de MySQL no filtra credenciales al modelo', async () => {
  const messages = await prepareAnswer({ provider: providerForTool(), model: 'test', messages: [], sakila: { query: async () => { throw new Error('password=secreto'); } } });
  const result = messages.find(m => m.role === 'tool').content;
  assert.match(result, /No se pudo consultar/);
  assert.ok(!result.includes('secreto'));
});
test('termina después de tres consultas', async () => {
  let count = 0;
  const messages = await prepareAnswer({ provider: providerForTool(true), model: 'test', messages: [], sakila: { query: async () => { count++; return { filas: [] }; } } });
  assert.equal(count, 3);
  assert.match(messages.at(-1).content, /límite/);
});
