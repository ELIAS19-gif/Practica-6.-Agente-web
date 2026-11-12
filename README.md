# Practica 6. Agente web

Aplicación de chat de acuerdo con la práctica: backend Node.js/Express, frontend HTML/CSS/JavaScript y SDK de OpenAI conectado a **OpenRouter**. Modelo configurado: `openai/gpt-4o-mini`.

## Ejecutar

Requiere Node.js 22.13 o superior (SQLite integrado).

```powershell
npm.cmd install
```

En `ai-backend/.env`, completa `OPENROUTER_API_KEY` con una clave de **OpenRouter**. Se incluye `.env.example` como plantilla. La clave permanece en el servidor; `.env` está excluido de Git. No la escribas en archivos del frontend.

```powershell
npm.cmd start
```

Abre http://localhost:3000. Reinicia el servidor si cambias `.env`. `npm.cmd run dev` activa la recarga al editar JavaScript del servidor. Usa la aplicación desde el servidor, no haciendo doble clic en el HTML: así la cookie de sesión y las peticiones comparten origen.

## Correspondencia con el diagrama

1. **Navegador / frontend / componente de chat:** `ai-frontend/index.html`, `styles.css` y `app.js`. Envío con Fetch, Enter para enviar y Shift+Enter para nueva línea.
2. **Endpoint:** `POST /api/chat`, cuerpo `{ "message": "Hola", "stream": false }`. Respuesta normal `{ "reply": "..." }`. Con `stream: true`, devuelve eventos SSE `data: {"delta":"..."}` y `data: {"done":true}`; los errores de un stream ya iniciado llegan como `data: {"error":"..."}`.
3. **Sesión / historial:** cookie aleatoria HttpOnly y SameSite=Strict. `GET /api/history` recupera la conversación; `DELETE /api/history` la borra. El servidor decide el contexto y no confía en un historial enviado por el cliente.
4. **Validación / control de acceso:** mensajes de hasta 4000 caracteres, JSON limitado, comprobación de origen, aislamiento por cookie, una solicitud simultánea y 15 solicitudes por minuto por sesión.
5. **Base de datos local:** `ai-backend/data/chat.sqlite`, creada al iniciar. Se conserva al reiniciar y se limpia por antigüedad de sesión a los siete días. Se envían al modelo los últimos 40 mensajes. Solo se guardan intercambios completados correctamente.
6. **Servicios externos:** el backend llama a `https://openrouter.ai/api/v1` mediante el SDK `openai`; el navegador nunca recibe la clave. El historial enviado al modelo sale hacia OpenRouter. Los mensajes se guardan en texto plano en el SQLite local.

La aplicación escucha únicamente en `127.0.0.1`. Es una práctica local, sin cuentas de usuario. La cookie identifica la conversación, no autentica una persona. Publicarla requeriría autenticación real, HTTPS, límites globales y una política de almacenamiento adecuada.

## Comprobación

```powershell
npm.cmd test
```

Las pruebas usan un proveedor simulado y no gastan saldo: verifican contexto, aislamiento, validación, historial, streaming y errores. Para comprobar OpenRouter se necesita una clave válida y saldo compatible con el modelo. Primero pregunta «Me llamo Elías» y después «¿Cómo me llamo?»; recarga para comprobar la persistencia y desactiva «Respuesta en tiempo real» para probar JSON.

La interfaz muestra si falta configurar la clave. Un error 401 indica credenciales inválidas; 402, saldo insuficiente; 429, límite de uso. El modelo puede cambiarse en `OPENROUTER_MODEL`.
