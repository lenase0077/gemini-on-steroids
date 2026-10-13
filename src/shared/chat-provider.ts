/** Supported native chat surfaces. Provider identity belongs to a local session, not its route id. */
export const CHAT_PROVIDERS = ['chatgpt', 'gemini'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export function normalizeChatProvider(value: unknown): ChatProvider {
  return value === 'gemini' ? 'gemini' : 'chatgpt';
}

export function newChatUrl(provider: ChatProvider = 'chatgpt'): string {
  return provider === 'gemini' ? 'https://gemini.google.com/app' : 'https://chatgpt.com/';
}

export function conversationUrl(provider: ChatProvider, conversationId: string): string {
  const id = encodeURIComponent(conversationId);
  return provider === 'gemini'
    ? `https://gemini.google.com/app/${id}`
    : `https://chatgpt.com/c/${id}`;
}
