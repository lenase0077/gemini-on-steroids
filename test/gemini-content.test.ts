import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const CONVERSATION = '4f8a9b2c1d3e5f60';
const INPUT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let page: JSDOM;

afterEach(() => page?.window.close());

function startContentPage(pathname: string, markup: string, options: {
  opening?: boolean;
  toolRows?: any[];
  deferFirstBridgeCall?: boolean;
} = {}) {
  page = new JSDOM(`<!doctype html><title>Gemini</title><main>${markup}</main>`, {
    url: `https://gemini.google.com${pathname}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = page.window as any;
  const sent: any[] = [];
  const bridgeCalls: any[] = [];
  let releaseFirstBridgeCall: (() => void) | null = null;
  let hook: any;
  let runtimeListener: any;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown, targetOrigin: string) => queueMicrotask(() => {
    win.dispatchEvent(new win.MessageEvent('message', { data, source: win, origin: targetOrigin === '*' ? win.location.origin : targetOrigin }));
  });
  win.CLF_TEST_HOOK = (value: unknown) => { hook = value; };
  win.setInterval = () => 0;
  win.chrome = {
    runtime: {
      id: 'gemini-fixture',
      onMessage: { addListener(listener: unknown) { runtimeListener = listener; }, removeListener() {} },
      sendMessage: async (message: any) => {
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, pending: 0 };
        if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], pendingTools: 0 } };
        if (message.type === 'correlate') return { ok: true, data: { conversationId: CONVERSATION, confirmed: [] } };
        if (message.type === 'desktop_input' && message.requiresAuthorization) return { ok: true, data: { input: {
          id: message.id, owner: 'gemini-input-fixture', text: 'Summarize this page', model: null,
          sessionId: 'session-gemini-opening-0001', reasoningEffort: null, attachments: [], images: [], lifetime: 'chat',
          provider: 'gemini',
          ...(options.opening ? { opening: true } : {})
        } } };
        if (message.type === 'desktop_input' && (message.authorize || message.ack)) return { ok: true, data: { ok: true } };
        if (message.type === 'mcp_bridge_tools') return { ok: true, status: 200, data: {
          surfaces: [{ surface: 'core', tools: options.toolRows || [] }],
          tools: (options.toolRows || []).map(tool => ({ surface: 'core', tool }))
        } };
        if (message.type === 'mcp_bridge_call') {
          bridgeCalls.push(message);
          if (options.deferFirstBridgeCall && bridgeCalls.length === 1) {
            return await new Promise(resolve => {
              releaseFirstBridgeCall = () => resolve({ ok: true, status: 200,
                data: { ok: true, content: [{ type: 'text', text: 'mock tool output' }] } });
            });
          }
          return { ok: true, status: 200, data: {
            ok: message.name !== 'read_file',
            ...(message.name === 'read_file' ? { isError: true } : {}),
            content: [{ type: 'text', text: message.name === 'read_file' ? 'read failed safely' : `result for ${message.name}` }]
          } };
        }
        return { ok: true, pending: 0, durable: true };
      }
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } }
  };
  win.eval(domSource);
  win.eval(contentSource);
  return {
    win,
    sent,
    bridgeCalls,
    releaseFirstBridgeCall: () => releaseFirstBridgeCall?.(),
    hook: () => hook,
    events: () => sent.filter(message => message.type === 'events').flatMap(message => message.entries.map((entry: any) => entry.event)),
    runtime: (message: any) => new Promise<any>(resolve => {
      if (typeof runtimeListener !== 'function') return resolve(undefined);
      const asynchronous = runtimeListener(message, {}, resolve);
      if (asynchronous !== true) resolve(asynchronous);
    })
  };
}

it('records Gemini user and final assistant messages through the v22 DOM shim', async () => {
  const pageFixture = startContentPage(`/app/${CONVERSATION}`, `
    <user-query><div class="query-text">Summarize this page</div></user-query>
    <model-response><message-content>The page is about a local project.</message-content></model-response>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`);
  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  await pageFixture.hook().refreshFiber();
  await pageFixture.hook().pullActivity();
  pageFixture.hook().observe();
  await pageFixture.hook().flush();

  await vi.waitFor(() => {
    expect(pageFixture.events()).toContainEqual(expect.objectContaining({ kind: 'user_message', text: 'Summarize this page' }));
    expect(pageFixture.events()).toContainEqual(expect.objectContaining({ kind: 'assistant_message', text: 'The page is about a local project.', final: true }));
  });
  expect(pageFixture.sent.some(message => message.type === 'events')).toBe(true);
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('prepares and sends app input from Gemini /app through content.js and the DOM adapter', async () => {
  const pageFixture = startContentPage('/app', `
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`);
  const editor = pageFixture.win.document.querySelector('.ql-editor');
  const send = pageFixture.win.document.querySelector('.send-button');
  let sendClicks = 0;
  expect(pageFixture.win.CLF_DOM.isNewChatPage()).toBe(true);
  send.addEventListener('click', () => {
    sendClicks++;
    pageFixture.win.setTimeout(() => {
    pageFixture.win.history.replaceState({}, '', `/app/${CONVERSATION}`);
    const user = pageFixture.win.document.createElement('user-query');
    user.innerHTML = '<div class="query-text">Summarize this page</div>';
    pageFixture.win.document.querySelector('main').prepend(user);
    editor.textContent = '';
    editor.dispatchEvent(new pageFixture.win.InputEvent('input', { bubbles: true }));
    }, 0);
  });

  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  expect(await pageFixture.runtime({ type: 'clf-input-reuse-state' })).toMatchObject({ safe: true });
  expect(await pageFixture.runtime({ type: 'clf-prepare-desktop-input', id: INPUT_ID, provider: 'gemini' })).toMatchObject({ ready: true });
  expect(new URL(pageFixture.win.location.href).searchParams.get('cos-input')).toBe(INPUT_ID);
  const sentResult = await pageFixture.runtime({ type: 'clf-desktop-input', id: INPUT_ID, provider: 'gemini', conversationId: null });
  expect(sentResult, JSON.stringify({ sent: pageFixture.sent, url: pageFixture.win.location.href,
    editor: editor.textContent, clicks: send.clicked })).toEqual({ ok: true });
  expect(sendClicks).toBe(1);
  expect(pageFixture.sent).toContainEqual(expect.objectContaining({
    type: 'desktop_input', ack: true, conversationId: CONVERSATION,
    messageId: expect.any(String), owner: 'gemini-input-fixture'
  }));
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('does not send the same Gemini input again while /app becomes /app/:id and user-query hydrates late', async () => {
  const pageFixture = startContentPage('/app', `
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`);
  const send = pageFixture.win.document.querySelector('.send-button');
  let sendClicks = 0;
  send.addEventListener('click', () => {
    sendClicks++;
    pageFixture.win.history.replaceState({}, '', `/app/${CONVERSATION}`);
    pageFixture.win.setTimeout(() => {
      const user = pageFixture.win.document.createElement('user-query');
      user.innerHTML = '<div class="query-text">Summarize this page</div>';
      pageFixture.win.document.querySelector('main').prepend(user);
      const editor = pageFixture.win.document.querySelector('.ql-editor');
      editor.textContent = '';
      editor.dispatchEvent(new pageFixture.win.InputEvent('input', { bubbles: true }));
    }, 80);
  });

  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  expect(await pageFixture.runtime({ type: 'clf-prepare-desktop-input', id: INPUT_ID, provider: 'gemini' })).toMatchObject({ ready: true });
  const offer = { type: 'clf-desktop-input', id: INPUT_ID, provider: 'gemini', conversationId: null };
  const first = pageFixture.runtime(offer);
  await vi.waitFor(() => expect(sendClicks).toBe(1));

  expect(await pageFixture.runtime(offer)).toEqual({ ok: false });
  await expect(first).resolves.toEqual({ ok: true });
  expect(sendClicks).toBe(1);
  expect(pageFixture.sent.filter(message => message.type === 'desktop_input' && message.authorize)).toHaveLength(1);
  expect(pageFixture.sent.filter(message => message.type === 'desktop_input' && message.ack)).toHaveLength(1);
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('bootstraps an app-owned Gemini opening once without replacing its original prompt', async () => {
  const pageFixture = startContentPage('/app', `
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`, {
    opening: true,
    toolRows: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]
  });
  const editor = pageFixture.win.document.querySelector('.ql-editor');
  const send = pageFixture.win.document.querySelector('.send-button');
  let submitted = '';
  let sendClicks = 0;
  send.addEventListener('click', () => {
    sendClicks++;
    submitted = editor.textContent;
    pageFixture.win.setTimeout(() => {
      pageFixture.win.history.replaceState({}, '', `/app/${CONVERSATION}`);
      const user = pageFixture.win.document.createElement('user-query');
      const text = pageFixture.win.document.createElement('div');
      text.className = 'query-text';
      text.textContent = submitted;
      user.append(text);
      pageFixture.win.document.querySelector('main').append(user);
      editor.textContent = '';
      editor.dispatchEvent(new pageFixture.win.InputEvent('input', { bubbles: true }));
    }, 0);
  });
  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  const originalPrompt = 'Summarize this page';
  const duplicateBootstrap = await pageFixture.hook().withGeminiMcpBootstrapForTest(
    originalPrompt, 'session:session-gemini-opening-0001', () => true
  );
  expect(duplicateBootstrap).toContain(originalPrompt);
  expect(duplicateBootstrap.match(/## Local CoS MCP tools/g)).toHaveLength(1);
  expect(pageFixture.sent.filter(message => message.type === 'mcp_bridge_tools')).toHaveLength(1);
  expect(await pageFixture.runtime({ type: 'clf-prepare-desktop-input', id: INPUT_ID, provider: 'gemini' })).toMatchObject({ ready: true });
  expect(await pageFixture.runtime({ type: 'clf-desktop-input', id: INPUT_ID, provider: 'gemini', conversationId: null })).toEqual({ ok: true });
  expect(sendClicks).toBe(1);
  expect(submitted).toContain('Summarize this page');
  expect(submitted).toContain('## Local CoS MCP tools (cos-mcp v1)');
  expect(submitted).toContain('read_file');
  expect(submitted).toContain('"surface":"core"');
  expect(submitted.match(/## Local CoS MCP tools/g)).toHaveLength(1);
  expect(pageFixture.sent.filter(message => message.type === 'mcp_bridge_tools')).toHaveLength(1);
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('accepts only complete exact cos-mcp fences and caps the result envelope at 30000 characters', async () => {
  const pageFixture = startContentPage('/app', `
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`);
  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  const parsed = pageFixture.hook().parseGeminiMcpFences([
    '```cos-mcp', '{"surface":"core","name":"read_file","arguments":{}}', '```',
    '```cos-mcp extra', '{"surface":"core","name":"read_file","arguments":{}}', '```',
    '```cos-mcp', '{"surface":"core","name":"read_file","arguments":{}}'
  ].join('\n'));
  expect(parsed).toHaveLength(1);
  expect(pageFixture.hook().parseGeminiMcpCall(parsed[0])).toMatchObject({
    surface: 'core', name: 'read_file', arguments: {}
  });
  const result = pageFixture.hook().boundedGeminiMcpResult([{
    callId: 'gemini-test', surface: 'core', name: 'read_file', ok: true, output: 'x'.repeat(40_000)
  }]);
  expect(result.length).toBeLessThanOrEqual(30_000);
  expect(result).toContain('cos-mcp-result');
  expect(result).toContain('[truncated]');
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('recognizes Angular cos-mcp headers and marked JSON without claiming ordinary JSON blocks', async () => {
  const pageFixture = startContentPage(`/app/${CONVERSATION}`, `
    <model-response><message-content>
      <code-block><div class="code-block-decoration"><span>cos-mcp</span></div><pre><code>{"surface":"core","name":"read_file","arguments":{}}</code></pre></code-block>
      <pre><code class="language-json">{"cos_mcp":true,"surface":"core","name":"list_files","arguments":{}}</code></pre>
      <pre><code class="language-json">{"surface":"core","name":"not_a_tool","arguments":{}}</code></pre>
    </message-content></model-response>`);
  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  const assistant = pageFixture.win.document.querySelector('message-content');
  const blocks = pageFixture.hook().geminiMcpBlocksFromMessageForTest({ rawText: '' }, assistant);

  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({ marked: true, text: '{"surface":"core","name":"read_file","arguments":{}}' });
  expect(blocks[1]).toMatchObject({ marked: false, text: '{"cos_mcp":true,"surface":"core","name":"list_files","arguments":{}}' });
  expect(pageFixture.hook().parseGeminiMcpCall(blocks[0])).toMatchObject({ surface: 'core', name: 'read_file' });
  expect(pageFixture.hook().parseGeminiMcpCall(blocks[1])).toMatchObject({ surface: 'core', name: 'list_files' });
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('auto-sends a repair request when a marked cos-mcp block contains invalid JSON', async () => {
  const pageFixture = startContentPage(`/app/${CONVERSATION}`, `
    <user-query><div class="query-text">Read the project README.</div></user-query>
    <model-response><message-content><code-block><div class="code-block-decoration"><span>cos-mcp</span></div><pre><code>{"surface":"core","name":</code></pre></code-block></message-content></model-response>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`);
  const editor = pageFixture.win.document.querySelector('.ql-editor');
  const send = pageFixture.win.document.querySelector('.send-button');
  let sendClicks = 0;
  send.addEventListener('click', () => {
    sendClicks++;
    const resultText = editor.textContent;
    pageFixture.win.setTimeout(() => {
      const user = pageFixture.win.document.createElement('user-query');
      const text = pageFixture.win.document.createElement('div');
      text.className = 'query-text';
      text.textContent = resultText;
      user.append(text);
      pageFixture.win.document.querySelector('main').append(user);
      editor.textContent = '';
      editor.dispatchEvent(new pageFixture.win.InputEvent('input', { bubbles: true }));
    }, 0);
  });
  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  pageFixture.hook().observe();
  await pageFixture.hook().refreshFiber();
  await vi.waitFor(() => expect(sendClicks).toBe(1));
  await vi.waitFor(() => {
    const resultRow = pageFixture.win.document.querySelector('main')?.lastElementChild;
    expect(resultRow?.textContent).toContain('cos-mcp-result');
    expect(resultRow?.textContent).toContain('Invalid JSON in cos-mcp block:');
    expect(resultRow?.textContent).toContain('Please re-emit valid JSON.');
  });
  expect(pageFixture.bridgeCalls).toHaveLength(0);
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});

it('executes stable final Gemini fences once and sends multiple tool results in one message', async () => {
  const toolRows = [
    { name: 'list_files', description: 'List files', inputSchema: { type: 'object' } },
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }
  ];
  const pageFixture = startContentPage(`/app/${CONVERSATION}`, `
    <user-query><div class="query-text">List then read.</div></user-query>
    <model-response><message-content></message-content></model-response>
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button class="send-button" aria-label="Send"></button>`, { toolRows, deferFirstBridgeCall: true });
  const assistant = pageFixture.win.document.querySelector('message-content');
  assistant.innerHTML = `First call:<pre><code class="language-cos-mcp">${JSON.stringify({ surface: 'core', name: 'list_files', arguments: { path: '.' } })}</code></pre>` +
    `Then:<pre><code class="language-cos-mcp">${JSON.stringify({ surface: 'core', name: 'read_file', arguments: { path: 'README.md' } })}</code></pre>`;
  const editor = pageFixture.win.document.querySelector('.ql-editor');
  const send = pageFixture.win.document.querySelector('.send-button');
  let sendClicks = 0;
  send.addEventListener('click', () => {
    sendClicks++;
    const resultText = editor.textContent;
    pageFixture.win.setTimeout(() => {
      const user = pageFixture.win.document.createElement('user-query');
      const text = pageFixture.win.document.createElement('div');
      text.className = 'query-text';
      text.textContent = resultText;
      user.append(text);
      pageFixture.win.document.querySelector('main').append(user);
      editor.textContent = '';
      editor.dispatchEvent(new pageFixture.win.InputEvent('input', { bubbles: true }));
    }, 0);
  });
  await vi.waitFor(() => expect(pageFixture.hook()).toBeTruthy());
  pageFixture.hook().observe();
  await vi.waitFor(() => expect(pageFixture.win.CLF_DOM.conversationId()).toBe(CONVERSATION));
  const extractedBlocks = pageFixture.hook().geminiMcpBlocksFromMessageForTest(
    { rawText: assistant.textContent }, assistant.closest('model-response')
  );
  expect(extractedBlocks).toHaveLength(2);
  expect(pageFixture.hook().parseGeminiMcpCall(extractedBlocks[0])).toMatchObject({ name: 'list_files' });
  const firstScan = pageFixture.hook().refreshFiber();
  await vi.waitFor(() => expect(pageFixture.bridgeCalls).toHaveLength(1));
  expect(pageFixture.bridgeCalls[0]).toMatchObject({
    type: 'mcp_bridge_call', surface: 'core', name: 'list_files',
    arguments: { path: '.' }, conversationId: CONVERSATION, callId: expect.stringMatching(/^gemini-/)
  });
  await pageFixture.hook().refreshFiber();
  expect(pageFixture.bridgeCalls).toHaveLength(1);
  pageFixture.releaseFirstBridgeCall();
  await firstScan;
  await vi.waitFor(() => expect(pageFixture.bridgeCalls).toHaveLength(2));
  await vi.waitFor(() => expect(sendClicks).toBe(1));
  await vi.waitFor(() => {
    const row = pageFixture.win.document.querySelector('main')?.lastElementChild;
    expect(row?.textContent).toContain('cos-mcp-result');
    expect(row?.textContent).toContain('mock tool output');
    expect(row?.textContent).toContain('read failed safely');
  });
  expect(pageFixture.bridgeCalls[1]).toMatchObject({ name: 'read_file', arguments: { path: 'README.md' } });
  const resultRow = pageFixture.win.document.querySelector('main')?.lastElementChild;
  const resultText = resultRow?.textContent || '';
  expect(resultText.match(/cos-mcp-result/g)).toHaveLength(2);
  expect(resultText).toContain('"name":"list_files"');
  expect(resultText).toContain('"ok":true');
  expect(resultText).toContain('"result":"mock tool output"');
  expect(resultText).toContain('"name":"read_file"');
  expect(resultText).toContain('"ok":false');
  expect(resultText).toContain('"result":"read failed safely"');
  expect(resultText).not.toContain('"output":');
  await pageFixture.hook().refreshFiber();
  expect(pageFixture.bridgeCalls).toHaveLength(2);
  expect(sendClicks).toBe(1);
  pageFixture.win.__CLF_CONTENT_RECORDER__?.stop();
});
