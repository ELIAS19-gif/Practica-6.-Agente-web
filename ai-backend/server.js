const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function createApp({ client, databasePath, configured } = {}) {
  const app = express();
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const ready = configured ?? Boolean(key);
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const provider = client || (ready ? new OpenAI({
    apiKey: key, baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: { 'X-Title': 'Practica 6 - Agente IA' },
    timeout: 60000, maxRetries: 0,
  }) : null);
  const dbPath = databasePath || path.join(__dirname, 'data', 'chat.sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
  // Solo se permite el cliente servido por esta aplicación; no se habilitan orígenes externos.
  app.use(cors({ origin: false }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    if (req.method !== 'GET' && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Origen no permitido.' });
      } catch { return res.status(403).json({ error: 'Origen no permitido.' }); }
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (req, res) => res.json({ configured: ready, model }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')));
    let id = cookies.chat_session;
    if (!id || !/^[a-f0-9]{64}$/.test(id) || !db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)) {
      id = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(id, Date.now());
      res.cookie('chat_session', id, { httpOnly: true, sameSite: 'strict', maxAge: 7 * 86400000, secure: req.secure });
    }
    req.sessionId = id;
    next();
  });
  const history = id => db.prepare('SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 40) ORDER BY id').all(id);
  const busy = new Set();
  const limits = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of limits) if (now - entry.start > 60000) limits.delete(id);
    db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now - 7 * 86400000);
  }, 60000);
  cleanup.unref();
  app.get('/api/history', (req, res) => res.json({ messages: history(req.sessionId) }));
  app.delete('/api/history', (req, res) => {
    if (busy.has(req.sessionId)) return res.status(409).json({ error: 'Espera a que termine la respuesta.' });
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.sessionId);
    res.json({ ok: true });
  });
  app.post('/api/chat', async (req, res) => {
    const { message, stream = false } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 || typeof stream !== 'boolean') {
      return res.status(400).json({ error: 'Escribe un mensaje de entre 1 y 4000 caracteres.' });
    }
    if (!ready) return res.status(503).json({ error: 'Falta configurar OPENROUTER_API_KEY en ai-backend/.env y reiniciar el servidor.' });
    const id = req.sessionId;
    if (busy.has(id)) return res.status(409).json({ error: 'Ya hay una respuesta en curso.' });
    const now = Date.now();
    const rate = limits.get(id);
    const entry = rate && now - rate.start < 60000 ? rate : { start: now, count: 0 };
    limits.set(id, entry);
    if (++entry.count > 15) return res.status(429).json({ error: 'Demasiados mensajes. Espera un minuto.' });
    busy.add(id);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const emit = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      const messages = [...history(id), { role: 'user', content: message.trim() }];
      const result = await provider.chat.completions.create({ model, messages, stream, max_tokens: 2048 }, { signal: abort.signal });
      let reply = '';
      if (stream) {
        res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        for await (const chunk of result) {
          const delta = chunk.choices?.[0]?.delta?.content || '';
          reply += delta;
          if (delta && !res.destroyed) emit({ delta });
        }
      } else reply = result.choices?.[0]?.message?.content || '';
      if (abort.signal.aborted) return;
      if (!reply.trim()) throw new Error('empty_response');
      db.exec('BEGIN');
      try {
        const insert = db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
        insert.run(id, 'user', message.trim(), Date.now());
        insert.run(id, 'assistant', reply, Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (stream) { emit({ done: true }); res.end(); }
      else res.json({ reply });
    } catch (error) {
      if (abort.signal.aborted || res.destroyed) return;
      const status = error.status;
      const explanation = status === 401 ? 'La clave de OpenRouter no es válida.'
        : status === 402 ? 'La cuenta de OpenRouter necesita saldo para este modelo.'
        : status === 429 ? 'OpenRouter alcanzó su límite de uso. Inténtalo más tarde.'
        : 'No se pudo obtener una respuesta de OpenRouter. Revisa la conexión e inténtalo otra vez.';
      if (res.headersSent) { emit({ error: explanation }); res.end(); }
      else res.status(status === 429 ? 429 : 502).json({ error: explanation });
    } finally { busy.delete(id); }
  });
  app.use(express.static(path.join(__dirname, '..', 'ai-frontend')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : 400).json({ error: 'Solicitud inválida o demasiado grande.' });
  });
  app.locals.close = () => { clearInterval(cleanup); db.close(); };
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, '127.0.0.1', () => console.log(`Agente IA: http://localhost:${port}`));
}
module.exports = { createApp };
