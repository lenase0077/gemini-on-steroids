import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

let domSource = '';
beforeAll(async () => {
  domSource = await fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8');
});

class GeminiNode {
  tagName: string;
  id = '';
  textContent: string;
  innerText: string;
  className: string;
  disabled = false;
  isConnected = true;
  parentElement: GeminiNode | null = null;
  attrs = new Map<string, string>();
  children = new Map<string, GeminiNode[]>();
  events: string[] = [];
  clicked = 0;
  onClick: (() => void) | null = null;

  constructor(tagName: string, text = '', attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.innerText = text;
    this.className = attrs.class || '';
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    this.id = attrs.id || '';
  }

  get classList(): string[] { return this.className.split(/\s+/).filter(Boolean); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  querySelectorAll(selector: string): GeminiNode[] { return this.children.get(selector) || []; }
  querySelector(selector: string): GeminiNode | null { return this.querySelectorAll(selector)[0] || null; }
  matches(selector: string): boolean {
    return selector.includes('model-response') && (this.tagName.toLowerCase() === 'model-response' || this.getAttribute('data-test-id') === 'model-response');
  }
  closest(selector: string): GeminiNode | null {
    if (this.matches(selector)) return this;
    if (selector.includes('[hidden]') && this.attrs.has('hidden')) return this;
    if (selector.includes('[aria-hidden="true"]') && this.getAttribute('aria-hidden') === 'true') return this;
    if (selector.includes('[inert]') && this.attrs.has('inert')) return this;
    return this.parentElement?.closest(selector) || null;
  }
  getClientRects(): Array<{ width: number; height: number }> { return [{ width: 20, height: 20 }]; }
  focus(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(event: { type?: string }): boolean { this.events.push(event.type || 'unknown'); return true; }
  click(): void { this.clicked++; this.onClick?.(); }
  cloneNode(): GeminiNode {
    const copy = new GeminiNode(this.tagName, this.textContent);
    copy.innerText = this.innerText;
    for (const [selector, nodes] of this.children) copy.children.set(selector, nodes.map(node => node.cloneNode()));
    return copy;
  }
  remove(): void { this.isConnected = false; }
}

const TURN_SELECTOR = 'user-query, [data-test-id="user-query"], model-response, [data-test-id="model-response"]';
const COMPOSER_SELECTOR = 'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"][role="textbox"], rich-textarea [contenteditable="true"]';
const SEND_SELECTOR = 'button.send-button, button[aria-label*="Send" i], button[aria-label*="Enviar" i], .send-button-container button:not([disabled])';
const STOP_SELECTOR = 'button.stop, button[aria-label*="Stop" i], button[aria-label*="Detener" i], .send-button.stop';

function loadGeminiDom(options: {
  turns?: GeminiNode[];
  composer?: GeminiNode | null;
  sendButtons?: GeminiNode[];
  stopButtons?: GeminiNode[];
  thoughts?: GeminiNode[];
  pathname?: string;
} = {}) {
  const fixture = {
    turns: options.turns || [],
    composer: options.composer || null,
    sendButtons: options.sendButtons || [],
    stopButtons: options.stopButtons || [],
    thoughts: options.thoughts || [],
    listeners: new Set<(event: { source: unknown; origin: string; data: unknown }) => void>(),
    posted: [] as Array<{ data: Record<string, unknown>; targetOrigin: string }>
  };
  const document = {
    title: 'Gemini',
    activeElement: null as GeminiNode | null,
    querySelectorAll(selector: string): GeminiNode[] {
      if (selector === TURN_SELECTOR) return fixture.turns;
      if (selector === 'model-thoughts') return fixture.thoughts;
      if (selector === SEND_SELECTOR) return fixture.sendButtons;
      if (selector === STOP_SELECTOR) return fixture.stopButtons;
      return [];
    },
    querySelector(selector: string): GeminiNode | null {
      return selector === COMPOSER_SELECTOR ? fixture.composer : null;
    },
    execCommand(command: string, _showUi?: boolean, value?: string): boolean {
      const editor = fixture.composer;
      if (!editor) return false;
      if (command === 'selectAll') return true;
      if (command === 'insertText') { editor.textContent = value || ''; editor.innerText = value || ''; return true; }
      if (command === 'delete') { editor.textContent = ''; editor.innerText = ''; return true; }
      return false;
    }
  };
  const windowObject = {
    addEventListener(type: string, listener: (event: { source: unknown; origin: string; data: unknown }) => void) {
      if (type === 'message') fixture.listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: { source: unknown; origin: string; data: unknown }) => void) {
      if (type === 'message') fixture.listeners.delete(listener);
    },
    postMessage(data: Record<string, unknown>, targetOrigin: string) { fixture.posted.push({ data, targetOrigin }); }
  };
  const context = vm.createContext({
    document,
    location: { hostname: 'gemini.google.com', pathname: options.pathname || '/app/4f8a9b2c1d3e5f60', origin: 'https://gemini.google.com', href: `https://gemini.google.com${options.pathname || '/app/4f8a9b2c1d3e5f60'}` },
    window: windowObject,
    URL,
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    InputEvent: class { type: string; constructor(type: string) { this.type = type; } },
    setTimeout,
    clearTimeout
  });
  vm.runInContext(domSource, context, { filename: 'chatgpt-dom.js' });
  return { dom: (context as unknown as { CLF_DOM: any }).CLF_DOM, fixture, windowObject };
}

function userQuery(text: string): GeminiNode {
  const node = new GeminiNode('user-query');
  node.children.set('.query-text', [new GeminiNode('div', text)]);
  return node;
}

function modelResponse(text: string, attrs: Record<string, string> = {}): GeminiNode {
  const node = new GeminiNode('model-response', '', attrs);
  node.children.set('message-content', [new GeminiNode('div', text)]);
  return node;
}

describe('Gemini DOM adapter', () => {
  it('recognizes only the Gemini /app root as a fresh chat route', () => {
    const fresh = loadGeminiDom({ pathname: '/app' }).dom;
    const active = loadGeminiDom({ pathname: '/app/4f8a9b2c1d3e5f60' }).dom;
    const invalid = loadGeminiDom({ pathname: '/app/not-a-conversation' }).dom;

    expect(fresh.isNewChatPage()).toBe(true);
    expect(fresh.conversationId()).toBeNull();
    expect(active.isNewChatPage()).toBe(false);
    expect(active.conversationId()).toBe('4f8a9b2c1d3e5f60');
    expect(invalid.isNewChatPage()).toBe(false);
    expect(invalid.conversationId()).toBeNull();
  });

  it('extracts ordered turns and text with stable message ids across scans', () => {
    const question = userQuery('Summarize this page');
    const answer = modelResponse('Here is the summary.');
    const { dom } = loadGeminiDom({ turns: [question, answer] });

    const firstTurns = dom.turns();
    const messages = dom.messages();
    expect(firstTurns.map((turn: any) => turn.role)).toEqual(['user', 'assistant']);
    expect(messages.map((message: any) => [message.role, message.text])).toEqual([
      ['user', 'Summarize this page'], ['assistant', 'Here is the summary.']
    ]);
    expect(messages[0].id).toBe(dom.messages()[0].id);
    expect(firstTurns[0].id).toBe(question.getAttribute('data-turn-key'));
  });

  it('extracts Angular code-block content when the cos-mcp language is only in its header', () => {
    const response = modelResponse('');
    const block = new GeminiNode('code-block');
    const header = new GeminiNode('span', 'cos-mcp');
    const code = new GeminiNode('code', '{"surface":"core","name":"read_file","arguments":{}}');
    header.parentElement = block;
    code.parentElement = block;
    block.children.set('.code-block-decoration span, [data-test-id="code-block-language"]', [header]);
    block.children.set('pre > code, pre code', [code]);
    response.children.set('code-block', [block]);
    const { dom } = loadGeminiDom({ turns: [response] });

    expect(dom.mcpCodeBlocks(response)).toEqual([{
      index: 0, text: '{"surface":"core","name":"read_file","arguments":{}}', marked: true
    }]);
  });

  it('inserts and clears exact text in the Quill editor and exposes a draft lease', async () => {
    const editor = new GeminiNode('div', '', { class: 'ql-editor', contenteditable: 'true' });
    const { dom } = loadGeminiDom({ composer: editor });

    expect(dom.insertPrompt('First line\nSecond line', true)).toBe(true);
    expect(dom.composerAuthoredText()).toBe('First line\nSecond line');
    const draft = dom.captureComposerDraft('First line\nSecond line');
    expect(draft.current()).toBe(true);
    expect(dom.clearPromptExact('different text')).toBe(false);
    expect(await draft.clear()).toBe(true);
    expect(dom.composerAuthoredText()).toBe('');
    expect(editor.events).toContain('input');
    expect(() => draft.dispose()).not.toThrow();
  });

  it('detects active generation, separates stop from send, and accepts a rendered user message after Send', async () => {
    const editor = new GeminiNode('div', 'Question', { class: 'ql-editor', contenteditable: 'true' });
    const send = new GeminiNode('button', '', { class: 'send-button' });
    const { dom, fixture } = loadGeminiDom({ composer: editor, sendButtons: [send] });
    expect(dom.generating()).toBe(false);
    expect(dom.sendButton()).toBe(send);

    const stop = new GeminiNode('button', '', { class: 'stop', 'aria-label': 'Stop generating' });
    fixture.stopButtons.push(stop);
    expect(dom.generating()).toBe(true);
    expect(dom.sendButton()).toBe(send);
    stop.onClick = () => { fixture.stopButtons.splice(0); };
    expect(dom.stopGeneration()).toBe(true);
    expect(dom.generating()).toBe(false);

    send.onClick = () => {
      fixture.turns.push(userQuery('Question'));
      editor.textContent = '';
      editor.innerText = '';
    };
    expect(await dom.send({ acceptanceTimeoutMs: 200 })).toBe(true);
  });

  it('does not treat a cleared composer as proof that Gemini accepted a send', async () => {
    const editor = new GeminiNode('div', 'Question', { class: 'ql-editor', contenteditable: 'true' });
    const send = new GeminiNode('button', '', { class: 'send-button' });
    send.onClick = () => { editor.textContent = ''; editor.innerText = ''; };
    const { dom } = loadGeminiDom({ composer: editor, sendButtons: [send] });

    expect(await dom.send({ acceptanceTimeoutMs: 25 })).toBe(false);
  });

  it('answers the v22 Fiber handshake with bounded DOM-backed message descriptors and exact stamps', () => {
    const question = userQuery('What is in this image?');
    const answer = modelResponse('A landscape.');
    const thoughts = new GeminiNode('model-thoughts', 'Analyzing the image');
    thoughts.parentElement = answer;
    const { dom, fixture, windowObject } = loadGeminiDom({ turns: [question, answer], thoughts: [thoughts] });
    const nonce = 'test-scan-123';
    for (const listener of fixture.listeners) {
      listener({ source: windowObject, origin: 'https://gemini.google.com', data: { source: 'clf-fiber-ask', nonce, apps: [], appIds: [] } });
    }

    const reply = fixture.posted.at(-1)?.data as any;
    expect(reply).toMatchObject({ source: 'clf-fiber-reply', nonce, v: 22, scanOk: true, scanToken: nonce, rows: [] });
    expect(reply?.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: dom.turns()[0].id, messages: [expect.objectContaining({ role: 'user', rawText: 'What is in this image?' })] }),
      expect.objectContaining({ turnId: dom.turns()[1].id, endMessageId: dom.messages()[1].id, messages: [expect.objectContaining({ role: 'assistant', rawText: 'A landscape.' })] })
    ]));
    expect(reply?.turns?.every((turn: any) => !turn.calls?.length && !turn.requests?.length)).toBe(true);
    expect(question.getAttribute('data-clf-fiber-turn')).toBe(`${nonce}:0`);
    expect(question.getAttribute('data-clf-fiber-user')).toContain(`${nonce}:0:`);
    expect(answer.getAttribute('data-clf-fiber-message')).toContain(`${nonce}:1:`);
    expect(thoughts.getAttribute('data-clf-fiber-thought')).toContain(`${nonce}:1:`);
  });
});
