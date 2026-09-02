/**
 * Pluggable LLM providers for memory extraction. Raw HTTP by design, the
 * server is provider-neutral and self-hosted, so we avoid vendor SDK
 * dependencies. Selected via MOTIF_LLM_PROVIDER:
 *   anthropic         , Anthropic Messages API (MOTIF_LLM_API_KEY)
 *   openai            , OpenAI chat completions (MOTIF_LLM_API_KEY)
 *   openai-compatible , any compatible endpoint (MOTIF_LLM_BASE_URL), e.g.
 *                        Ollama, vLLM, OpenRouter
 *   claude-code       , shells out to the local `claude` CLI; no API key
 *   off               , memory disabled (default)
 */

import { spawn } from 'node:child_process';

export interface LLMProvider {
  readonly name: string;
  completeJSON(opts: { system: string; user: string; maxTokens?: number }): Promise<unknown>;
}

export interface ProviderConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function extractJSON(text: string): unknown {
  // tolerate prose or fences around the JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}

class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async completeJSON(opts: { system: string; user: string; maxTokens?: number }): Promise<unknown> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
      stop_reason?: string;
    };
    if (data.stop_reason === 'refusal') throw new Error('anthropic: request refused');
    const text = data.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
    return extractJSON(text);
  }
}

class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  constructor(
    name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {
    this.name = name;
  }

  async completeJSON(opts: { system: string; user: string; maxTokens?: number }): Promise<unknown> {
    const res = await fetch(
      new URL('chat/completions', this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`),
      {
        method: 'POST',
        headers: {
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens ?? 4096,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
        }),
      },
    );
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return extractJSON(data.choices[0]?.message.content ?? '');
  }
}

class ClaudeCodeExecProvider implements LLMProvider {
  readonly name = 'claude-code';

  completeJSON(opts: { system: string; user: string }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--output-format', 'json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', (e) => reject(new Error(`claude CLI not available: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
        try {
          // --output-format json wraps the reply; the reply itself contains our JSON
          const wrapper = JSON.parse(out) as { result?: string };
          resolve(extractJSON(wrapper.result ?? out));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      child.stdin.write(`${opts.system}\n\n${opts.user}`);
      child.stdin.end();
      setTimeout(() => child.kill(), 180_000).unref();
    });
  }
}

export function createProvider(config: ProviderConfig = {}): LLMProvider | undefined {
  const provider = config.provider ?? process.env.MOTIF_LLM_PROVIDER ?? 'off';
  const apiKey = config.apiKey ?? process.env.MOTIF_LLM_API_KEY;
  const baseUrl = config.baseUrl ?? process.env.MOTIF_LLM_BASE_URL;
  const model = config.model ?? process.env.MOTIF_LLM_MODEL;

  switch (provider) {
    case 'off':
    case '':
      return undefined;
    case 'anthropic':
      if (!apiKey) throw new Error('MOTIF_LLM_API_KEY required for anthropic provider');
      return new AnthropicProvider(apiKey, model ?? 'claude-opus-5');
    case 'openai':
      if (!apiKey) throw new Error('MOTIF_LLM_API_KEY required for openai provider');
      return new OpenAICompatibleProvider('openai', 'https://api.openai.com/v1/', apiKey, model ?? 'gpt-5.2');
    case 'openai-compatible':
      if (!baseUrl) throw new Error('MOTIF_LLM_BASE_URL required for openai-compatible provider');
      if (!model) throw new Error('MOTIF_LLM_MODEL required for openai-compatible provider');
      return new OpenAICompatibleProvider('openai-compatible', baseUrl, apiKey, model);
    case 'claude-code':
      return new ClaudeCodeExecProvider();
    default:
      throw new Error(`Unknown MOTIF_LLM_PROVIDER "${provider}"`);
  }
}
