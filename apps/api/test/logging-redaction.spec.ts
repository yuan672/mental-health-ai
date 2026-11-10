import { Writable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import pino from 'pino';
import { applicationLogProperties, LOG_REDACT_PATHS } from '../src/app.module';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
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
      'mood-note-secret',
      'mood-emotion-secret',
      'mood-trend-secret',
      'knowledge-query-secret',
      'knowledge-body-secret',
      'knowledge-snippet-secret',
      'knowledge-reference-secret',
      'knowledge-source-url-secret',
      'staff-initial-password-secret',
      'knowledge-admin-title-secret',
      'knowledge-admin-summary-secret',
      'knowledge-admin-block-secret',
      'knowledge-admin-publisher-secret',
      'knowledge-admin-source-title-secret',
      'knowledge-admin-source-locator-secret',
      'cat-mood-secret',
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
      moodScore: 5,
      catMood: sensitiveValues[29],
      emotion: sensitiveValues[15],
      note: sensitiveValues[14],
      dailyTrend: sensitiveValues[16],
      query: sensitiveValues[17],
      knowledgeBody: sensitiveValues[18],
      knowledgeSnippet: sensitiveValues[19],
      knowledgeReferences: [{ title: sensitiveValues[20] }],
      sourceUrl: sensitiveValues[21],
      initialPassword: sensitiveValues[22],
      title: sensitiveValues[23],
      summary: sensitiveValues[24],
      contentBlocks: [{ type: 'paragraph', text: sensitiveValues[25] }],
      sources: [
        {
          publisherName: sensitiveValues[26],
          sourceTitle: sensitiveValues[27],
          sourceLocator: sensitiveValues[28],
        },
      ],
    });

    for (const sensitiveValue of [...sensitiveValues, 'sensitive body', 'private-context-id']) {
      expect(output).not.toContain(sensitiveValue);
    }
  });

  it('keeps an operational route shape without logging an Incognito context id', () => {
    const contextId = '11111111-1111-4111-8111-111111111111';
    expect(safeOperationalPath(`/incognito-contexts/${contextId}`)).toBe(
      '/incognito-contexts/:contextId',
    );
    expect(safeOperationalPath(`/incognito-contexts/${contextId}/`)).toBe(
      '/incognito-contexts/:contextId/',
    );
    expect(safeOperationalPath(`/incognito-contexts/${contextId}/unexpected`)).toBe(
      '/incognito-contexts/:contextId/unexpected',
    );
    expect(safeOperationalPath(`/incognito-contexts/${contextId}?private=query`)).toBe(
      '/incognito-contexts/:contextId',
    );
    for (const unsafePath of [
      `/incognito-contexts/${contextId}`,
      `/incognito-contexts/${contextId}/`,
      `/incognito-contexts/${contextId}/unexpected`,
      `/incognito-contexts/${contextId}?private=query`,
    ]) {
      expect(safeOperationalPath(unsafePath)).not.toContain(contextId);
    }
    expect(safeOperationalPath('/conversations?cursor=private')).toBe('/conversations');
    const staffId = '22222222-2222-4222-8222-222222222222';
    expect(safeOperationalPath(`/admin/staff-principals/${staffId}/roles`)).toBe(
      '/admin/staff-principals/:id/roles',
    );
    expect(safeOperationalPath(`/admin/staff-principals/${staffId}/roles`)).not.toContain(staffId);
  });

  it('collapses the complete AI metadata path family in ordinary and error logs', () => {
    const turnId = '33333333-3333-4333-8333-333333333333';
    const repeatedId = '44444444-4444-4444-8444-444444444444';
    const querySecret = 'private-filter-value';
    const unsafeSuffix = 'private-unexpected-suffix';
    const unsafePaths = [
      `/admin/ai-quality/turns/${turnId}`,
      `/admin/ai-quality/turns/${turnId}/`,
      `/admin/ai-quality/turns/${turnId}?filter=${querySecret}`,
      `/ADMIN/AI-QUALITY/TURNS/${turnId}`,
      `/AdMiN/aI-qUaLiTy/TuRnS/${turnId}`,
      `/admin/ai-quality/turns/${turnId}/${repeatedId}/${unsafeSuffix}`,
      `/admin/ai-quality/turns//${turnId}`,
    ];

    for (const unsafePath of unsafePaths) {
      const safePath = safeOperationalPath(unsafePath);
      expect(safePath).toBe('/admin/ai-quality/turns/:turnId');
      expect(applicationLogProperties({ url: unsafePath } as IncomingMessage)).toEqual({
        logType: 'application',
        path: '/admin/ai-quality/turns/:turnId',
      });
      for (const forbidden of [turnId, repeatedId, querySecret, unsafeSuffix]) {
        expect(safePath).not.toContain(forbidden);
      }
    }

    expect(
      applicationLogProperties({
        url: `/admin/ai-quality/turns?filter=${querySecret}`,
      } as IncomingMessage),
    ).toEqual({ logType: 'application', path: '/admin/ai-quality/turns' });

    const filter = new AppExceptionFilter();
    const logger = (filter as unknown as { logger: { error: (value: unknown) => void } }).logger;
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      for (const unsafePath of unsafePaths) {
        filter.catch(new Error('synthetic failure'), {
          switchToHttp: () => ({
            getRequest: () => ({ method: 'GET', path: unsafePath }),
            getResponse: () => ({ destroyed: true, writableEnded: false }),
          }),
        } as never);
      }
      expect(error).toHaveBeenCalledTimes(unsafePaths.length);
      for (const [entry] of error.mock.calls) {
        expect(entry).toEqual(expect.objectContaining({ path: '/admin/ai-quality/turns/:turnId' }));
        const serialized = JSON.stringify(entry);
        for (const forbidden of [turnId, repeatedId, querySecret, unsafeSuffix]) {
          expect(serialized).not.toContain(forbidden);
        }
      }
    } finally {
      error.mockRestore();
    }
  });
});
