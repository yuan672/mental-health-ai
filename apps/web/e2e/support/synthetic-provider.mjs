import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const port = Number(process.env.SYNTHETIC_PROVIDER_PORT ?? 4010);

function jsonResponse(response, content) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      model: 'synthetic-phase5b-model',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
  );
}

function writeStreamFrame(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    jsonResponse(response, '{}');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (body.stream === true) {
      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      response.flushHeaders();
      writeStreamFrame(response, {
        model: 'synthetic-phase5b-model',
        choices: [{ delta: { content: '这是合成的' }, finish_reason: null }],
      });
      setTimeout(() => {
        writeStreamFrame(response, {
          model: 'synthetic-phase5b-model',
          choices: [{ delta: { content: '安全流式回复。' }, finish_reason: 'stop' }],
        });
        response.write('data: [DONE]\n\n');
        response.end();
      }, 80);
      return;
    }

    const systemPrompt = String(body.messages?.[0]?.content ?? '');
    if (systemPrompt.includes('候选 AI 回复') || systemPrompt.includes('输出边界')) {
      jsonResponse(response, JSON.stringify({ decision: 'ALLOW', reasonCodes: [] }));
      return;
    }
    if (systemPrompt.includes('安全情境分类')) {
      jsonResponse(
        response,
        JSON.stringify({
          candidateLevel: 'LOW',
          harmSubject: 'UNKNOWN',
          harmTargets: [],
          temporality: 'CURRENT',
          ideation: 'NONE',
          intent: 'ABSENT',
          plan: 'ABSENT',
          means: 'ABSENT',
          immediacy: 'NONE',
          confidence: 0.99,
          reasonCodes: [],
        }),
      );
      return;
    }
    jsonResponse(response, '这是合成的安全完整回复。');
  });
});

server.listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
