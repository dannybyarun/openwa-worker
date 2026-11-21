/**
 * OpenAI-compatible `/chat/completions` client.
 *
 * The worker only needs a base URL, a model name and (usually) a bearer key, so one
 * code path covers OpenAI, Groq, OpenRouter, Together, Fireworks, Ollama, LM Studio
 * and vLLM. Keep this module free of Durable Object imports so the URL builder can be
 * unit-tested without a worker.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAiChatOptions {
  baseUrl?: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export const DEFAULT_OPENAI_TIMEOUT_MS = 20_000;

/** Accept both `https://host/v1` and a full `…/chat/completions` URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

/**
 * One non-streaming completion. Throws with a short, user-facing message on any failure
 * so the caller can surface it as a `502` without leaking the whole provider response.
 */
export async function callOpenAiChat(options: OpenAiChatOptions): Promise<string> {
  if (!options.baseUrl) {
    throw new Error('OpenAI-compatible base URL is not set (Settings → AI & auto-reply)');
  }
  if (!options.model) {
    throw new Error('model is not set for the OpenAI-compatible provider');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        max_tokens: options.maxTokens ?? 300,
        temperature: options.temperature ?? 0.4,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      /abort/i.test(message)
        ? 'the provider did not answer in time'
        : `could not reach the provider: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`provider returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const payload = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> }
    | null;
  const choice = payload?.choices?.[0];
  const answer = textFromContent(choice?.message?.content) || textFromContent(choice?.text);
  if (!answer) throw new Error('the provider returned an empty answer');
  return answer;
}
