const $ = id => document.getElementById(id);
const form = $('chatForm');
const input = $('userInput');
const box = $('chatBox');
let sending = false;

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
  return data;
}
function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function scrollDown() { box.scrollTop = box.scrollHeight; }
function appendMessage(content, role, pending = false) {
  $('welcome').hidden = true;
  const element = document.createElement('div');
  element.className = `message ${role}${pending ? ' pending' : ''}`;
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = '✳';
  avatar.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;
  element.append(avatar, body);
  box.append(element);
  scrollDown();
  return { element, body };
}
function setBusy(value) {
  sending = value;
  $('sendButton').disabled = value;
  $('newChat').disabled = value;
  input.disabled = value;
  $('streamMode').disabled = value;
  box.setAttribute('aria-busy', String(value));
}
async function loadHistory() {
  const { messages } = await request('/api/history');
  box.querySelectorAll('.message').forEach(element => element.remove());
  $('welcome').hidden = messages.length > 0;
  messages.forEach(message => appendMessage(message.content, message.role));
}
async function readStream(response, answer) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', done = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!event.startsWith('data: ')) continue;
        const data = JSON.parse(event.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.delta) {
          text += data.delta;
          answer.element.classList.remove('pending');
          answer.body.textContent = text;
          scrollDown();
        }
        if (data.done) done = true;
      }
    }
    if (!done) throw new Error('La respuesta se interrumpió. Inténtalo otra vez.');
  } finally { reader.releaseLock(); }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || sending) return;
  showError();
  setBusy(true);
  const user = appendMessage(message, 'user');
  input.value = '';
  const answer = appendMessage('Pensando…', 'assistant', true);
  try {
    const stream = $('streamMode').checked;
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, stream }) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'No se pudo enviar el mensaje.');
    }
    if (stream) await readStream(response, answer);
    else { const { reply } = await response.json(); answer.body.textContent = reply; }
    answer.element.classList.remove('pending');
  } catch (error) {
    user.element.remove(); answer.element.remove();
    input.value = message;
    showError(error.message || 'No hay conexión con el servidor.');
    // Reconciliar con el servidor por si la conexión se perdió después de guardar.
    try { await loadHistory(); } catch { /* conservar el error y permitir reintentar */ }
    $('welcome').hidden = box.querySelectorAll('.message').length > 0;
  } finally { setBusy(false); scrollDown(); input.focus(); }
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  if (!sending) { input.value = button.dataset.prompt; input.focus(); }
}));
$('newChat').addEventListener('click', async () => {
  if (sending) return;
  if (box.querySelector('.message') && !confirm('¿Borrar el historial de esta conversación y empezar de nuevo?')) return;
  try { await request('/api/history', { method: 'DELETE' }); await loadHistory(); showError(); input.value = ''; input.focus(); }
  catch (error) { showError(error.message); }
});
async function initialize() {
  setBusy(true);
  try {
    const health = await request('/api/health');
    $('modelName').textContent = health.model;
    $('status').textContent = health.configured ? '● Asistente conectado · Historial guardado en este equipo' : '○ Conexión pendiente · Configura tu clave de OpenRouter para comenzar';
    $('status').classList.toggle('pending', !health.configured);
    await loadHistory();
  } catch { $('status').textContent = 'No se pudo conectar con el servidor.'; }
  finally { setBusy(false); }
}
initialize();
