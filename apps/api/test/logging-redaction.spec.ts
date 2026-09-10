import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT_PATHS } from '../src/app.module';
import { safeOperationalPath } from '../src/common/http/safe-request-path';

describe('sensitive logging redaction', () => {
  it('removes passwords, identifiers, session, cookie, CSRF, and API-key material', () => {
    let output = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString('utf8');
        callback();
      },
    });
    const logger = pino(
      {
        redact: {
          paths: [...LOG_REDACT_PATHS],
          remove: true,
        },
      },
      destination,
    );

    const sensitiveValues = [
      'person@example.test',
      'password-secret',
      'raw-session-secret',
      'csrf-secret',
      'cookie-secret',
      'api-key-secret',
      'provider-evidence-secret',
      'message-content-secret',
      'nested-message-content-secret',
      'conversation-content-secret',
      'prompt-secret',
      'reasoning-secret',
      'provider-request-secret',
      'provider-response-secret',
    ];
    logger.info({
      req: {
        url: '/incognito-contexts/private-context-id',
        headers: {
          cookie: sensitiveValues[4],
          'x-csrf-token': sensitiveValues[3],
          'x-api-key': sensitiveValues[5],
        },
        body: { privateConversation: 'sensitive body' },
      },
      auth: {
        email: sensitiveValues[0],
        password: sensitiveValues[1],
        rawToken: sensitiveValues[2],
        csrfToken: sensitiveValues[3],
        evidenceToken: sensitiveValues[6],
      },
      content: sensitiveValues[7],
      message: { content: sensitiveValues[8] },
      conversationContent: sensitiveValues[9],
      prompt: sensitiveValues[10],
      reasoning_content: sensitiveValues[11],
      rawProviderRequest: sensitiveValues[12],
      rawProviderResponse: sensitiveValues[13],
    });

    for (const sensitiveValue of [...sensitiveValues, 'sensitive body', 'private-context-id']) {
      expect(output).not.toContain(sensitiveValue);
    }
  });

  it('keeps an operational route shape without logging an Incognito context id', () => {
    expect(safeOperationalPath('/incognito-contexts/11111111-1111-4111-8111-111111111111')).toBe(
      '/incognito-contexts/:contextId',
    );
    expect(safeOperationalPath('/conversations?cursor=private')).toBe('/conversations');
  });
});
