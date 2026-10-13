# Checklist de implementación: integración Gemini Web para Chat-On-Steroids

> Fase 0 se completó en el reconocimiento del 2026-10-13. El adjunto fuente termina a mitad del criterio 5.3; ese criterio queda señalado sin completar ni inventar el texto faltante.

## Fase 0: Reconocimiento y diagnóstico

- [x] **0.1.** Mapeo de archivos en `extension/` y localización de selectores de ChatGPT.
- [x] **0.2.** Identificación del protocolo HTTP/WebSocket entre `extension/` y `src/main/`, incluidos los puertos del browser bridge `8765–8769`.
- [x] **0.3.** Identificación del endpoint local del servidor MCP dentro de Electron.

## Fase 1: Permisos, emparejamiento y ruteo base — implementación completada

- [x] **1.1.** Agregar `https://gemini.google.com/*` al match de los content scripts aislados. `host_permissions` ya incluye `https://*/*`; los scripts MAIN de Fiber y usage siguen limitados a ChatGPT.
- [x] **1.2.** Adaptar el detector de URLs, las pestañas activas y el regex de sesión para aceptar `/app` (chat nuevo) y `/app/:id` (16 caracteres hexadecimales).
- [ ] **1.3.** QA manual pendiente: verificar en la UI de Electron que el estado pase a «Connected / Paired» con una pestaña de Gemini abierta. La ruta y el filtrado se probaron en unit tests; no se verificó la UI en vivo.

## Fase 2: Manipulación del DOM de Gemini (content script)

- [x] **2.1.** Implementar `composer()` apuntando a `rich-textarea div.ql-editor[contenteditable="true"]` con fallbacks de rol/editor.
- [x] **2.2.** Implementar `insertPrompt()` / `clearPromptExact()` con `execCommand` y evento `InputEvent`; cubrir editor vacío de Quill en unit tests.
- [x] **2.3.** Implementar `sendButton()`, `stopButton()` y `send()` con soporte Send/Enviar; aceptar solo tras observar el nuevo mensaje de usuario exacto.
- [x] **2.4.** Integrar el shim v22 con el observador existente de `content.js`: turnos DOM acotados, `endMessageId` para respuesta final y estado de generación basado en Stop/streaming. El fixture de integración verifica la emisión de mensajes del usuario y respuesta final; la progresión de pensamiento en Gemini real sigue pendiente de QA manual.
- [x] **2.5.** Prueba automatizada: simular el outbox de Electron hacia `/app`, verificar inserción, Send, recibo del mensaje de usuario y ACK; un fixture separado verifica que `content.js` registre la respuesta del modelo. La prueba desde la UI real de Electron queda pendiente.

> Los tests de la Fase 2 usan un fixture DOM simulado; no demuestran que los selectores correspondan a la interfaz Gemini desplegada actualmente. La validación manual en Chrome/Electron sigue pendiente.

## Fase 3: Puente MCP-over-DOM (core del Camino A)

- [x] **3.1.** Consultar `GET /mcp-bridge/tools` y agregar una instrucción Markdown compacta con el catálogo JSON de herramientas a la primera entrada ordinaria y los prompts app-owned de workers/reanudaciones; cachear por sesión o ID estable de comando.
- [x] **3.2.** Analizar únicamente bloques completos `cos-mcp` de la respuesta final estable de Gemini, vinculada al token e índice exactos del scan de Fiber; leer también los bloques renderizados `pre > code.language-cos-mcp` y deduplicar por conversación, mensaje, índice y hash.
- [x] **3.3.** Validar superficie/herramienta contra el catálogo habilitado y enviar cada invocación por el bridge autenticado de la extensión; las pruebas del bridge cubren el despacho JSON-RPC local y la atribución.
- [x] **3.4.** Agregar todas las respuestas `cos-mcp-result` en un único mensaje y enviarlo con la ruta nativa del composer Gemini bajo sus checks de ownership.
- [x] **3.5.** Limitar el mensaje agregado a 30.000 caracteres y agregar `[truncated]` cuando se recorta una respuesta o se omiten resultados.

> La validación Phase 3 es automatizada con fixtures DOM y mocks del runtime; las pruebas de `src/main/bridge.ts` verifican el endpoint real de pasarela. No se realizó QA en Gemini Web en vivo.

## Fase 4: Workflows avanzados y proveedor por sesión — implementación automatizada

- [x] **4.1.** Agregar una preferencia explícita ChatGPT/Gemini para chats nuevos; congelar el proveedor al aceptar el input y persistirlo en la sesión.
- [x] **4.2.** Heredar el proveedor de la sesión propietaria en Goal/Loop, Workers y Compact & Resume. Los datos legados o sesiones sin proveedor conservan ChatGPT; no se infiere desde el ID ni desde la pestaña seleccionada.
- [x] **4.3.** Enrutar apertura, revival, reanudación, wake de input, apertura/copia desde la UI y chats Worker mediante constructores URL compartidos. Tests cubren URLs Gemini de chats nuevos, Workers y Resume.
- [x] **4.4.** Separar readiness del MCP local para Gemini de la conexión remota/túnel y de la prueba de conectores nativos de ChatGPT. Las llamadas del gateway local no cuentan como instalación/uso de plugin nativo.
- [ ] **4.5.** QA en vivo de Goal/Loop, Compact & Resume y dos Workers simultáneos en Gemini Web.

> Límite conocido: el navegador integrado CoS sigue siendo específico de ChatGPT (inicio de sesión, transferencia de cookies y detección `/c/:id`). Para Gemini, usar Chrome/Edge/Brave con la extensión compañera; la selección de CoS Browser no está adaptada ni verificada.

## Fase 5: Robustez y QA

- [x] **5.1.** Endurecer la extracción para `pre > code.language-cos-mcp`, `<code-block>` Angular con cabecera `cos-mcp`, JSON con marcador `"cos_mcp": true` y `// cos-mcp`; un JSON inválido claramente marcado genera un `cos-mcp-result` de autocorrección. Cubierto por `test/gemini-dom.test.ts` y `test/gemini-content.test.ts`.
- [ ] **5.2.** QA manual pendiente: verificar que Stop de Electron detenga el autoenvío en la extensión durante una llamada MCP-over-DOM.
- [ ] **5.3.** Prueba de fuego en Gemini Web pendiente. El texto fuente de este criterio está truncado después de «cree un t…»; no se completó ni se inventó el alcance restante.

## Guía breve de ejecución en modo desarrollo (prueba manual pendiente)

1. En la raíz del fork, ejecutá `npm run dev`, agregá el proyecto local y aprobá el acceso necesario; en Settings elegí **Gemini** como proveedor de chats nuevos.
2. En Chrome abrí `chrome://extensions`, activá Developer mode y usá **Load unpacked** para cargar la carpeta `extension/` de este checkout. Emparejá la extensión desde Setup de Electron.
3. En el mismo perfil de Chrome, abrí `https://gemini.google.com/app` y pedile que lea un archivo existente dentro del proyecto aprobado usando las herramientas locales de CoS.
4. Verificá que Gemini reciba un mensaje automático `cos-mcp-result` con el resultado y que Electron registre la llamada/resultado MCP en la sesión. Esta guía describe la recepción esperada; no se ejecutó QA con Chrome/Gemini en vivo.
