import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { LLMProviderFailure } from '../src/ai/providers/llm-provider';
import { SiliconFlowProvider } from '../src/ai/providers/siliconflow.provider';

type Scenario =
  | 'chat'
  | 'risk'
  | 'malformed-risk'
  | 'stream'
  | 'malformed'
  | 'authentication'
  | 'rate-limited'
  | 'upstream'
  | 'abort'
  | 'health';

const REQUEST = {
  requestId: '11111111-1111-4111-8111-111111111111',
  messages: [{ role: 'user' as const, content: 'synthetic-provider-test' }],
  maxOutputTokens: 100,
};

describe('SiliconFlowProvider', () => {
  let server: Server;
  let baseUrl: string;
  let scenario: Scenario;
  let streamEnded = false;
  let receivedAuthorization = '';
  let receivedBody = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      receivedAuthorization = String(request.headers.authorization ?? '');
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        receivedBody += chunk;
      });
      request.on('end', () => handleResponse(response));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  beforeEach(() => {
    scenario = 'stream';
    streamEnded = false;
    receivedAuthorization = '';
    receivedBody = '';
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });

  function handleResponse(response: ServerResponse): void {
    response.setHeader('x-siliconcloud-trace-id', 'safe-trace-id');
    if (scenario === 'health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (scenario === 'authentication') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"secret":"must-not-escape"}');
      return;
    }
    if (scenario === 'rate-limited') {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end('{"secret":"must-not-escape"}');
      return;
    }
    if (scenario === 'upstream') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"secret":"must-not-escape"}');
      return;
    }
    if (scenario === 'chat') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { content: 'synthetic-answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      );
      return;
    }
    if (scenario === 'risk' || scenario === 'malformed-risk') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'test-model',
          choices: [
            {
              message: {
                content:
                  scenario === 'malformed-risk'
                    ? '{"candidateLevel":"UNBOUNDED"}'
                    : JSON.stringify({
                        candidateLevel: 'HIGH',
                        harmSubject: 'OTHER',
                        harmTargets: ['SELF_HARM'],
                        temporality: 'CURRENT',
                        ideation: 'ACTIVE',
                        intent: 'UNKNOWN',
                        plan: 'UNKNOWN',
                        means: 'UNKNOWN',
                        immediacy: 'POTENTIAL',
                        confidence: 0.82,
                        reasonCodes: ['THIRD_PARTY_REPORT'],
                      }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (scenario === 'malformed') {
      response.end('data: {not-json}\n\ndata: [DONE]\n\n');
      return;
    }
    if (scenario === 'abort') {
      response.write('data: {"model":"test-model","choices":[]}\n\n');
      return;
    }

    response.write('data: {"model":"test-model","choices":[{"delta":{"content":"真实"}');
    setTimeout(() => {
      response.write(',"finish_reason":null}]}\n\n');
      setTimeout(() => {
        response.write(
          'data: {"model":"test-model","choices":[{"delta":{"content":"流式。","reasoning_content":"not-forwarded"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
        );
        response.end('data: [DONE]\n\n');
        streamEnded = true;
      }, 30);
    }, 10);
  }

  function provider(): SiliconFlowProvider {
    return new SiliconFlowProvider({ apiKey: 'provider-secret', baseUrl, model: 'test-model' });
  }

  it('maps non-streaming chat responses without exposing raw payloads', async () => {
    scenario = 'chat';
    const result = await provider().chat(REQUEST, { signal: new AbortController().signal });

    expect(result).toEqual({
      content: 'synthetic-answer',
      finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      metadata: { provider: 'siliconflow', model: 'test-model', requestId: 'safe-trace-id' },
    });
    expect(receivedAuthorization).toBe('Bearer provider-secret');
    expect(JSON.parse(receivedBody)).toMatchObject({ stream: false, model: 'test-model' });
  });

  it('emits actual provider deltas before the upstream stream closes', async () => {
    scenario = 'stream';
    const stream = provider().streamChat(REQUEST, { signal: new AbortController().signal });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'started' } });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', text: '真实' },
    });
    expect(streamEnded).toBe(false);

    const remaining = [];
    while (true) {
      const item = await iterator.next();
      if (item.done) break;
      remaining.push(item.value);
    }
    expect(remaining).toEqual(
      expect.arrayContaining([
        { type: 'text_delta', text: '流式。' },
        { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
        expect.objectContaining({ type: 'completed', finishReason: 'stop' }),
      ]),
    );
    expect(JSON.stringify(remaining)).not.toContain('reasoning_content');
  });

  it.each([
    ['authentication', 'authentication'],
    ['rate-limited', 'rate_limited'],
    ['upstream', 'upstream'],
    ['malformed', 'malformed_stream'],
  ] as const)('maps %s failures to a safe typed category', async (testScenario, category) => {
    scenario = testScenario;
    const consume = async (): Promise<void> => {
      const stream = provider().streamChat(REQUEST, {
        signal: new AbortController().signal,
      });
      const iterator = stream[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Consume the contract to surface deferred generator failures.
      }
    };

    try {
      await consume();
      throw new Error('Expected provider failure');
    } catch (error) {
      expect(error).toMatchObject({
        name: LLMProviderFailure.name,
        category,
        providerRequestId: 'safe-trace-id',
      });
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('provider-secret');
      expect(serialized).not.toContain('must-not-escape');
    }
  });

  it('propagates AbortSignal to the upstream stream and releases the reader', async () => {
    scenario = 'abort';
    const controller = new AbortController();
    const stream = provider().streamChat(REQUEST, { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(new Error('synthetic-abort'));
    await expect(iterator.next()).rejects.toMatchObject({ category: 'aborted' });
  });

  it('provides a lightweight health check', async () => {
    scenario = 'health';
    await expect(
      provider().healthCheck({ signal: new AbortController().signal }),
    ).resolves.toMatchObject({ status: 'healthy' });
  });

  it('normalizes a strict structured risk-classification response', async () => {
    const instance = provider();
    scenario = 'risk';
    await expect(
      instance.classifyRisk(
        {
          requestId: REQUEST.requestId,
          messages: REQUEST.messages,
          maxOutputTokens: 128,
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      candidateLevel: 'HIGH',
      harmSubject: 'OTHER',
      harmTargets: ['SELF_HARM'],
      reasonCodes: ['THIRD_PARTY_REPORT'],
      metadata: { provider: 'siliconflow', requestId: 'safe-trace-id' },
    });
    expect(JSON.parse(receivedBody)).toMatchObject({
      stream: false,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  });

  it('rejects malformed risk classification and keeps embedding explicitly unsupported', async () => {
    const instance = provider();
    scenario = 'malformed-risk';
    await expect(
      instance.classifyRisk(
        {
          requestId: REQUEST.requestId,
          messages: REQUEST.messages,
          maxOutputTokens: 128,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ category: 'malformed_response' });
    await expect(
      instance.embed(
        { requestId: REQUEST.requestId, inputs: ['synthetic'] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ capability: 'embed' });
  });
});
