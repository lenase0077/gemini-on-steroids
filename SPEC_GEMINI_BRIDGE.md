# SPEC: Gemini Web DOM Bridge & MCP Emulator for Chat-On-Steroids

## 1. Objetivo de arquitectura

Permitir que `chat-on-steroids` (CoS) utilice la interfaz web de Google Gemini (`https://gemini.google.com/*`) como motor de inferencia y orquestación de agentes (Workers, Goal/Loop y Compact & Resume), manteniendo un costo de API de 0 mediante la emulación del protocolo MCP a través del DOM del navegador.

## 2. Arquitectura objetivo

```text
[Gemini Web DOM (Angular / Web Components)]
          │ observa turnos; detecta cos-mcp; recibe cos-mcp-result
          ▼
[Chrome Extension: adaptador DOM por proveedor]
          │ HTTP autenticado: /mcp-bridge/tools y /mcp-bridge/call
          │ WebSocket /wake: solo señal de reactivación
          ▼
[Electron: browser bridge → MCP kernel]
          │ herramientas registradas + atribución exacta
          └── operaciones locales limitadas por permisos vigentes
```

### Límite del transporte actual (baseline verificado el 2026-10-13)

- Los puertos `8765–8769` corresponden al browser bridge de la extensión. Su WebSocket `/wake` solo autentica y despierta al worker; no transporta llamadas MCP ni resultados.
- El servidor MCP es un listener HTTP separado en `127.0.0.1` con puerto asignado por el sistema operativo y rutas secretas distintas por superficie.
- El endpoint `/events` del browser bridge registra observaciones; no ejecuta herramientas. La invocación Gemini → `tools/call` requiere una ruta explícita; no debe suponerse que `/wake` ya la proporciona.
- La extensión actual es ChatGPT-céntrica. El bridge valida IDs de conversación como 8–64 caracteres hexadecimales o guiones, rango compatible con el ID Gemini de 16 caracteres confirmado para este trabajo.

### Decisiones confirmadas para el Camino A

- Se soportará `https://gemini.google.com/*` sin quitar el soporte existente de ChatGPT.
- `https://gemini.google.com/app` (sin ID) representa un chat nuevo; `/app/:id` representa una conversación activa. El ID es de 16 caracteres hexadecimales.
- En Gemini no se buscarán ni simularán React Fibers. El adaptador DOM para Angular/Web Components proporcionará a `content.js` la interfaz común necesaria.
- Las solicitudes y respuestas de herramientas usarán bloques cercados `cos-mcp` y `cos-mcp-result`, respectivamente.
- La pasarela HTTP futura residirá en `src/main/bridge.ts`, autenticada con el Bearer token existente. No reutilizará `/events` ni `/wake` para ejecutar herramientas.

## 3. Especificación de componentes

### 3.1. Permisos y ruteo (`extension/manifest.json`)

- Agregar `https://gemini.google.com/*` a `content_scripts.matches`. `host_permissions` ya contiene `https://*/*`, por lo que cubre Gemini sin permiso redundante.
- Mantener compatibilidad dual con adaptadores DOM por proveedor; no reemplazar el target de ChatGPT por Gemini.
- **Mapeo de URLs de sesión:**
  - ChatGPT: `https://chatgpt.com/c/{uuid}` o `/g/{id}/c/{uuid}`.
  - Gemini: `https://gemini.google.com/app/{id}` con ID de 16 caracteres hexadecimales; `https://gemini.google.com/app` es un chat nuevo.

### 3.2. Adaptador DOM para Angular / Web Components de Gemini

La interfaz de Gemini Web se considera construida con Angular y Web Components. El content script debe implementar selectores y manejadores resilientes:

> Los selectores indicados aquí son candidatos del brief. Validarlos en la interfaz web actual de Gemini antes de usarlos en producción; no se hizo una inspección live del DOM en Fase 0.

1. **Composer (`injectPrompt`):**
   - Selectores candidatos: `rich-textarea div.ql-editor[contenteditable="true"]` o `div[contenteditable="true"][role="textbox"]`.
   - **Requisito crítico de inyección:** Angular/Quill podría ignorar cambios directos a `.innerText` o `.textContent`. Para inyectar prompts o resultados de herramientas extensos:
     1. Enfocar el elemento con `.focus()`.
     2. Usar `document.execCommand('insertText', false, payload)` o despachar un `InputEvent('input', { bubbles: true, cancelable: true })` / `ClipboardEvent('paste')` para que el estado interno de Angular habilite el botón de envío.
2. **Botón de envío (`triggerSend`):**
   - Selectores candidatos: `button.send-button`, `button[aria-label*="Send"]`, `button[aria-label*="Enviar"]` o el botón dentro de `.input-buttons-wrapper-bottom`.
3. **Detección de streaming y fin de turno (`TurnObserver`):**
   - Observar el contenedor de respuestas (`model-response`, `message-content`).
   - Detectar inicio de generación (aparición del botón Stop o un indicador de carga) y fin de generación (DOM estable durante 600 ms sin mutaciones y desaparición del botón para detener la generación).
4. **Extracción de respuesta:**
   - Extraer el texto renderizado y los bloques `<pre><code>` del último `model-response` finalizado.

### 3.3. Protocolo MCP-over-DOM (puente de herramientas)

Como Gemini Web no se conecta por túnel HTTP al servidor MCP de CoS, la extensión actuará como proxy MCP.

1. **Bootstrap de sesión (inyección de instrucciones):**
   - Al iniciar un chat gestionado por CoS o después de un *Compact & Resume*, consultar al servidor MCP local por la lista de herramientas (`tools/list`).
   - Anteponer al primer mensaje del usuario un bloque compacto de instrucciones que defina las herramientas activas y exija este formato:

   ````markdown
   ```cos-mcp
   {"name": "tool_name", "arguments": {"arg1": "value"}}
   ```
   ````

   El bloque cercado es el protocolo requerido; no se dependerá de tags XML personalizados que la interfaz pueda ocultar o sanitizar.

2. **Intercepción y ejecución:**
   - Cuando `TurnObserver` confirme que Gemini terminó su turno, buscar bloques `cos-mcp` en el último mensaje del modelo.
   - La extensión enviará una solicitud autenticada con nombre, argumentos e identidad de conversación observada. El bridge verificará la conversación contra la pestaña y el navegador llamantes, y cualquier `agentCommandId` contra su lease vigente; `agent` y `agentCommandId` nunca se confiarán al texto del modelo.
   - `src/main/bridge.ts` expondrá `GET /mcp-bridge/tools?surface=...` para listar herramientas de una sola superficie (`core`, `desktop` o `plugins`, sin mezclarlas) y `POST /mcp-bridge/call` para ejecutarlas. Ambas rutas reutilizarán autenticación, validación, contexto de caller y guardas de permisos. El despacho se conectará al kernel/handler MCP ya registrado, sin abrir una nueva conexión a un proceso MCP externo ni saltarse correlación.
   - El resultado se conservará para que Electron pueda reflejar la ejecución en Timeline y Live Tool Results, y la extensión lo empaquetará así:

        ````markdown
        ```cos-mcp-result
        {"tool": "tool_name", "status": "ok", "output": "..."}
        ```
        ````

   - Inyectar `cos-mcp-result` automáticamente en el composer de Gemini y activar el envío nativo de la página.

#### Contrato HTTP objetivo de la pasarela

- `GET /mcp-bridge/tools?surface=...` consulta el catálogo MCP de una sola superficie sin ejecutar handlers ni mezclar herramientas.
- `POST /mcp-bridge/call` recibe `{ surface, name, arguments, conversationId, agentCommandId? }`; nunca acepta `agent` del modelo. El bridge valida la conversación contra la pestaña/navegador autenticados y `agentCommandId` contra su lease exacto cuando aplique.
- Cada llamada obtiene un `requestId` único y una correlación exacta `requestId → conversationId → sessionId` antes del despacho. `kernel.dispatch` deriva la identidad del caller de esa evidencia; no acepta una `conversationId` arbitraria como identidad.
- Un dispatcher dedicado debe reutilizar esquemas/handlers registrados y el ciclo normal de `kernel.dispatch`. No debe llamar handlers crudos ni `invokeNested` sin un contexto padre auténtico. Debe conservar permisos vigentes, bloqueo/trust, supersesión, correlación y registro de resultados.

### 3.4. Workflows avanzados

- **Workers:** cada Worker asignado por Electron abrirá/controlará su propia pestaña `https://gemini.google.com/app`, manteniendo el mapeo `workerId ↔ tabId ↔ geminiConversationId`.
- **Compact & Resume:** cuando el contexto se llene o CoS dispare un Compact & Resume, navegar a `https://gemini.google.com/app` (chat nuevo) e inyectar el resumen de estado y el esquema de herramientas MCP antes de continuar el loop.

## 4. Flujo de extremo a extremo

1. La extensión se empareja con la app de Electron mientras hay una pestaña de Gemini abierta.
2. Enviar una tarea desde la UI de Electron escribe el prompt en Gemini Web y lo envía.
3. Si Gemini responde con un bloque `cos-mcp`, se ejecuta la herramienta local (por ejemplo, leer un archivo del workspace) y la extensión devuelve el resultado a Gemini.
4. El bucle se detiene cuando Gemini entrega una respuesta final sin más llamadas a herramientas o emite la señal de finalización de Goal.
