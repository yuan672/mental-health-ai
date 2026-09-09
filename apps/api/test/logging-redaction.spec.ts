import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT_PATHS } from '../src/app.module';

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
    ];
    logger.info({
      req: {
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
    });

    for (const sensitiveValue of [...sensitiveValues, 'sensitive body']) {
      expect(output).not.toContain(sensitiveValue);
    }
  });
});
