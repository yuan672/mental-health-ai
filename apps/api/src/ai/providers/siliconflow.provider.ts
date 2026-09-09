import { z } from 'zod';
import {
  LLMProviderFailure,
  LLMUnsupportedCapabilityError,
  type LLMCallOptions,
  type LLMChatRequest,
  type LLMChatResult,
  type LLMEmbeddingRequest,
  type LLMEmbeddingResult,
  type LLMFinishReason,
  type LLMHealthStatus,
  type LLMProvider,
  type LLMProviderMetadata,
  type LLMProviderStreamEvent,
  type LLMRiskClassificationCandidate,
  type LLMRiskClassificationRequest,
  type LLMTokenUsage,
} from './llm-provider';

export type SiliconFlowConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
}>;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const chatResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable() }).passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: usageSchema.optional(),
  })
  .passthrough();

const streamResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
                reasoning_content: z.unknown().optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: usageSchema.optional(),
  })
  .passthrough();

const EMPTY_USAGE: LLMTokenUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};

function normalizeUsage(usage: z.infer<typeof usageSchema> | undefined): LLMTokenUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

function normalizeFinishReason(reason: string | null | undefined): LLMFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content_filter':
      return reason;
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    default:
      return 'unknown';
  }
}

function providerMetadata(
  config: SiliconFlowConfig,
  response: Response,
  model = config.model,
): LLMProviderMetadata {
  return {
    provider: 'siliconflow',
    model,
    requestId: response.headers.get('x-siliconcloud-trace-id'),
  };
}

function nextFrame(buffer: string): { frame: string; remainder: string } | null {
  const boundary = /\r?\n\r?\n/u.exec(buffer);
  if (!boundary || boundary.index === undefined) {
    return null;
  }
  return {
    frame: buffer.slice(0, boundary.index),
    remainder: buffer.slice(boundary.index + boundary[0].length),
  };
}

function frameData(frame: string): string | null {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return data.length > 0 ? data : null;
}

export class SiliconFlowProvider implements LLMProvider {
  constructor(
    private readonly config: SiliconFlowConfig,
    private readonly fetcher: FetchLike = globalThis.fetch,
  ) {}

  async chat(request: LLMChatRequest, options: LLMCallOptions): Promise<LLMChatResult> {
    const response = await this.fetchCompletion(request, options.signal, false);
    let parsed: z.infer<typeof chatResponseSchema>;
    try {
      parsed = chatResponseSchema.parse(await response.json());
    } catch {
      throw new LLMProviderFailure(
        'upstream',
        true,
        response.headers.get('x-siliconcloud-trace-id'),
      );
    }

    const choice = parsed.choices[0];
    if (!choice) {
      throw new LLMProviderFailure('upstream', true);
    }

    return {
      content: choice.message.content ?? '',
      finishReason: normalizeFinishReason(choice.finish_reason),
      usage: normalizeUsage(parsed.usage),
      metadata: providerMetadata(this.config, response, parsed.model),
    };
  }

  async *streamChat(
    request: LLMChatRequest,
    options: LLMCallOptions,
  ): AsyncIterable<LLMProviderStreamEvent> {
    const response = await this.fetchCompletion(request, options.signal, true);
    if (!response.body) {
      throw new LLMProviderFailure(
        'malformed_stream',
        true,
        response.headers.get('x-siliconcloud-trace-id'),
      );
    }

    let metadata = providerMetadata(this.config, response);
    let usage = EMPTY_USAGE;
    let finishReason: LLMFinishReason = 'unknown';
    let sawDone = false;
    let buffer = '';
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    yield { type: 'started', metadata };

    try {
      while (!sawDone) {
        const item = await reader.read();
        buffer += decoder.decode(item.value, { stream: !item.done });

        let frame = nextFrame(buffer);
        while (frame) {
          buffer = frame.remainder;
          const data = frameData(frame.frame);
          if (data === '[DONE]') {
            sawDone = true;
            break;
          }
          if (data) {
            let parsed: z.infer<typeof streamResponseSchema>;
            try {
              parsed = streamResponseSchema.parse(JSON.parse(data));
            } catch {
              throw new LLMProviderFailure('malformed_stream', true, metadata.requestId);
            }

            if (parsed.model) {
              metadata = { ...metadata, model: parsed.model };
            }
            if (parsed.usage) {
              usage = normalizeUsage(parsed.usage);
              yield { type: 'usage', usage };
            }

            for (const choice of parsed.choices ?? []) {
              if (choice.delta.content) {
                yield { type: 'text_delta', text: choice.delta.content };
              }
              if (choice.finish_reason) {
                finishReason = normalizeFinishReason(choice.finish_reason);
              }
            }
          }
          frame = nextFrame(buffer);
        }

        if (item.done) {
          break;
        }
      }
    } catch (error) {
      if (error instanceof LLMProviderFailure) {
        throw error;
      }
      if (options.signal.aborted) {
        throw new LLMProviderFailure('aborted', false, metadata.requestId);
      }
      throw new LLMProviderFailure('network', true, metadata.requestId);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    if (!sawDone) {
      throw new LLMProviderFailure('malformed_stream', true, metadata.requestId);
    }

    yield { type: 'completed', finishReason, usage, metadata };
  }

  classifyRisk(
    request: LLMRiskClassificationRequest,
    options: LLMCallOptions,
  ): Promise<LLMRiskClassificationCandidate> {
    void request;
    void options;
    return Promise.reject(new LLMUnsupportedCapabilityError('classifyRisk'));
  }

  embed(request: LLMEmbeddingRequest, options: LLMCallOptions): Promise<LLMEmbeddingResult> {
    void request;
    void options;
    return Promise.reject(new LLMUnsupportedCapabilityError('embed'));
  }

  async healthCheck(options: LLMCallOptions): Promise<LLMHealthStatus> {
    const startedAt = Date.now();
    try {
      const response = await this.fetcher(new URL('models', this.normalizedBaseUrl()), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: options.signal,
      });
      return {
        status: response.ok ? 'healthy' : 'unavailable',
        checkedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        status: 'unavailable',
        checkedAt: new Date(),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private normalizedBaseUrl(): string {
    return this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`;
  }

  private async fetchCompletion(
    request: LLMChatRequest,
    signal: AbortSignal,
    stream: boolean,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(new URL('chat/completions', this.normalizedBaseUrl()), {
        method: 'POST',
        headers: {
          Accept: stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          stream,
        }),
        signal,
      });
    } catch {
      throw new LLMProviderFailure(signal.aborted ? 'aborted' : 'network', !signal.aborted);
    }

    if (!response.ok) {
      const requestId = response.headers.get('x-siliconcloud-trace-id');
      if (response.status === 401 || response.status === 403) {
        throw new LLMProviderFailure('authentication', false, requestId);
      }
      if (response.status === 429) {
        throw new LLMProviderFailure('rate_limited', true, requestId);
      }
      throw new LLMProviderFailure('upstream', response.status >= 500, requestId);
    }

    return response;
  }
}
