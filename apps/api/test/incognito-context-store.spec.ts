import { env } from '../src/config/env';
import {
  IncognitoContextLimitError,
  IncognitoContextTerminatedError,
  IncognitoGenerationAlreadyClaimedError,
  IncognitoGenerationInProgressError,
  IncognitoSessionExpiredError,
  InMemoryIncognitoContextStore,
} from '../src/ai/incognito/incognito-context.store';

const NOW = new Date('2026-09-10T00:00:00.000Z');

type MutableLimits = Pick<
  typeof env,
  | 'INCOGNITO_CONTEXT_TTL_SECONDS'
  | 'INCOGNITO_CONTEXT_CLEANUP_INTERVAL_MS'
  | 'INCOGNITO_CONTEXT_MAX_GLOBAL'
  | 'INCOGNITO_CONTEXT_MAX_PER_USER'
  | 'INCOGNITO_CONTEXT_MAX_PER_SESSION'
  | 'INCOGNITO_CONTEXT_MAX_REQUESTS'
  | 'INCOGNITO_CONTEXT_MAX_MESSAGES'
  | 'INCOGNITO_CONTEXT_MAX_CHARACTERS'
  | 'INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS'
>;

const originalLimits: MutableLimits = {
  INCOGNITO_CONTEXT_TTL_SECONDS: env.INCOGNITO_CONTEXT_TTL_SECONDS,
  INCOGNITO_CONTEXT_CLEANUP_INTERVAL_MS: env.INCOGNITO_CONTEXT_CLEANUP_INTERVAL_MS,
  INCOGNITO_CONTEXT_MAX_GLOBAL: env.INCOGNITO_CONTEXT_MAX_GLOBAL,
  INCOGNITO_CONTEXT_MAX_PER_USER: env.INCOGNITO_CONTEXT_MAX_PER_USER,
  INCOGNITO_CONTEXT_MAX_PER_SESSION: env.INCOGNITO_CONTEXT_MAX_PER_SESSION,
  INCOGNITO_CONTEXT_MAX_REQUESTS: env.INCOGNITO_CONTEXT_MAX_REQUESTS,
  INCOGNITO_CONTEXT_MAX_MESSAGES: env.INCOGNITO_CONTEXT_MAX_MESSAGES,
  INCOGNITO_CONTEXT_MAX_CHARACTERS: env.INCOGNITO_CONTEXT_MAX_CHARACTERS,
  INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS: env.INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS,
};

function setLimits(overrides: Partial<MutableLimits> = {}): void {
  Object.assign(env, originalLimits, overrides);
}

function sessionExpiry(milliseconds = 60_000): Date {
  return new Date(NOW.getTime() + milliseconds);
}

describe('bounded Incognito context runtime', () => {
  afterEach(() => {
    setLimits();
    jest.useRealTimers();
  });

  it('enforces session, user, and global context caps without evicting live contexts', () => {
    setLimits({
      INCOGNITO_CONTEXT_MAX_GLOBAL: 4,
      INCOGNITO_CONTEXT_MAX_PER_USER: 3,
      INCOGNITO_CONTEXT_MAX_PER_SESSION: 1,
    });
    const store = new InMemoryIncognitoContextStore();
    const first = store.create('user-1', 'session-1', sessionExpiry(), NOW);

    expect(() => store.create('user-1', 'session-1', sessionExpiry(), NOW)).toThrow(
      expect.objectContaining({ reason: 'session_context_limit' }),
    );
    store.create('user-1', 'session-2', sessionExpiry(), NOW);
    store.create('user-1', 'session-3', sessionExpiry(), NOW);
    expect(() => store.create('user-1', 'session-4', sessionExpiry(), NOW)).toThrow(
      expect.objectContaining({ reason: 'user_context_limit' }),
    );
    store.create('user-2', 'session-4', sessionExpiry(), NOW);
    expect(() => store.create('user-3', 'session-5', sessionExpiry(), NOW)).toThrow(
      expect.objectContaining({ reason: 'global_context_limit' }),
    );
    expect(store.get('user-1', 'session-1', first.id, NOW)).not.toBeNull();
    store.onModuleDestroy();
  });

  it('rejects an already expired session and caps inactivity TTL at session expiry', () => {
    setLimits({ INCOGNITO_CONTEXT_TTL_SECONDS: 10 });
    const store = new InMemoryIncognitoContextStore();

    expect(() => store.create('user', 'session', NOW, NOW)).toThrow(IncognitoSessionExpiredError);
    const context = store.create('user', 'session', sessionExpiry(2_000), NOW);
    expect(context.expiresAt).toEqual(sessionExpiry(2_000));
    store.onModuleDestroy();
  });

  it('refreshes inactivity TTL only on generation claim and append, never beyond session expiry', () => {
    setLimits({ INCOGNITO_CONTEXT_TTL_SECONDS: 1 });
    const store = new InMemoryIncognitoContextStore();
    const expiresAt = sessionExpiry(3_000);
    const created = store.create('user', 'session', expiresAt, NOW);
    expect(created.expiresAt).toEqual(new Date(NOW.getTime() + 1_000));

    expect(
      store.get('user', 'session', created.id, new Date(NOW.getTime() + 500))?.expiresAt,
    ).toEqual(created.expiresAt);
    const claim = store.claimGeneration(
      'user',
      'session',
      created.id,
      'request',
      new AbortController().signal,
      new Date(NOW.getTime() + 800),
    );
    if (!claim) throw new Error('Expected a generation claim');
    expect(
      store.get('user', 'session', created.id, new Date(NOW.getTime() + 900))?.expiresAt,
    ).toEqual(new Date(NOW.getTime() + 1_800));
    const appended = store.append(
      'user',
      'session',
      created.id,
      claim.id,
      { role: 'user', content: 'synthetic' },
      new Date(NOW.getTime() + 1_700),
    );
    expect(appended?.expiresAt).toEqual(new Date(NOW.getTime() + 2_700));
    const capped = store.append(
      'user',
      'session',
      created.id,
      claim.id,
      { role: 'assistant', content: 'synthetic' },
      new Date(NOW.getTime() + 2_600),
    );
    expect(capped?.expiresAt).toEqual(expiresAt);
    store.onModuleDestroy();
  });

  it('rejects overlarge whole messages and bounded context message/content growth', () => {
    setLimits({
      INCOGNITO_CONTEXT_MAX_MESSAGES: 2,
      INCOGNITO_CONTEXT_MAX_CHARACTERS: 6,
      INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS: 4,
    });
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const claim = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request',
      new AbortController().signal,
      NOW,
    );
    if (!claim) throw new Error('Expected a generation claim');

    expect(() =>
      store.append(
        'user',
        'session',
        context.id,
        claim.id,
        {
          role: 'user',
          content: '12345',
        },
        NOW,
      ),
    ).toThrow(expect.objectContaining({ reason: 'message_too_large' }));
    store.append('user', 'session', context.id, claim.id, { role: 'user', content: '1234' }, NOW);
    store.append(
      'user',
      'session',
      context.id,
      claim.id,
      { role: 'assistant', content: '56' },
      NOW,
    );
    expect(() =>
      store.append(
        'user',
        'session',
        context.id,
        claim.id,
        {
          role: 'user',
          content: 'x',
        },
        NOW,
      ),
    ).toThrow(expect.objectContaining({ reason: 'context_message_limit' }));
    expect(store.get('user', 'session', context.id, NOW)?.messages).toEqual([
      { role: 'user', content: '1234' },
      { role: 'assistant', content: '56' },
    ]);
    store.onModuleDestroy();
  });

  it('rejects context character overflow without partially appending a message', () => {
    setLimits({
      INCOGNITO_CONTEXT_MAX_MESSAGES: 3,
      INCOGNITO_CONTEXT_MAX_CHARACTERS: 5,
      INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS: 5,
    });
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const claim = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request',
      new AbortController().signal,
      NOW,
    );
    if (!claim) throw new Error('Expected a generation claim');
    store.append('user', 'session', context.id, claim.id, { role: 'user', content: '1234' }, NOW);

    expect(() =>
      store.append(
        'user',
        'session',
        context.id,
        claim.id,
        {
          role: 'assistant',
          content: '56',
        },
        NOW,
      ),
    ).toThrow(expect.objectContaining({ reason: 'context_character_limit' }));
    expect(store.get('user', 'session', context.id, NOW)?.messages).toEqual([
      { role: 'user', content: '1234' },
    ]);
    store.onModuleDestroy();
  });

  it('allows only one generation per context and rejects stale writes after release', () => {
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const first = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request-1',
      new AbortController().signal,
      NOW,
    );
    if (!first) throw new Error('Expected a generation claim');
    expect(() =>
      store.claimGeneration(
        'user',
        'session',
        context.id,
        'request-2',
        new AbortController().signal,
        NOW,
      ),
    ).toThrow(IncognitoGenerationInProgressError);
    expect(store.releaseGeneration('user', 'session', context.id, first.id)).toBe(true);
    expect(
      store.append(
        'user',
        'session',
        context.id,
        first.id,
        { role: 'assistant', content: 'late' },
        NOW,
      ),
    ).toBeNull();

    const second = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request-2',
      new AbortController().signal,
      NOW,
    );
    if (!second) throw new Error('Expected a second generation claim');
    expect(
      store.append(
        'user',
        'session',
        context.id,
        first.id,
        { role: 'assistant', content: 'late' },
        NOW,
      ),
    ).toBeNull();
    expect(
      store.append(
        'user',
        'session',
        context.id,
        second.id,
        {
          role: 'assistant',
          content: 'accepted',
        },
        NOW,
      ),
    ).not.toBeNull();
    store.onModuleDestroy();
  });

  it('keeps completed client request ids for the context lifetime and rejects their reuse', () => {
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const first = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request-1',
      new AbortController().signal,
      NOW,
    );
    if (!first) throw new Error('Expected a generation claim');
    expect(store.releaseGeneration('user', 'session', context.id, first.id)).toBe(true);

    expect(() =>
      store.claimGeneration(
        'user',
        'session',
        context.id,
        'request-1',
        new AbortController().signal,
        NOW,
      ),
    ).toThrow(IncognitoGenerationAlreadyClaimedError);
    expect(
      store.claimGeneration(
        'user',
        'session',
        context.id,
        'request-2',
        new AbortController().signal,
        NOW,
      ),
    ).not.toBeNull();
    store.onModuleDestroy();
  });

  it('bounds completed client request ids without silently forgetting idempotency state', () => {
    setLimits({ INCOGNITO_CONTEXT_MAX_REQUESTS: 1 });
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const first = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request-1',
      new AbortController().signal,
      NOW,
    );
    if (!first) throw new Error('Expected a generation claim');
    store.releaseGeneration('user', 'session', context.id, first.id);

    expect(() =>
      store.claimGeneration(
        'user',
        'session',
        context.id,
        'request-2',
        new AbortController().signal,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ reason: 'context_request_limit' }));
    store.onModuleDestroy();
  });

  it.each([
    [
      'end',
      (store: InMemoryIncognitoContextStore, contextId: string) =>
        store.end('user', 'session', contextId),
      'ended',
    ],
    [
      'session clear',
      (store: InMemoryIncognitoContextStore) => store.clearSession('user', 'session'),
      'session_cleared',
    ],
    [
      'user clear',
      (store: InMemoryIncognitoContextStore) => store.clearUser('user'),
      'user_cleared',
    ],
  ] as const)(
    'aborts an active generation on %s and rejects its late append',
    (_name, clear, reason) => {
      const store = new InMemoryIncognitoContextStore();
      const context = store.create('user', 'session', sessionExpiry(), NOW);
      const claim = store.claimGeneration(
        'user',
        'session',
        context.id,
        'request',
        new AbortController().signal,
        NOW,
      );
      if (!claim) throw new Error('Expected a generation claim');

      expect(clear(store, context.id)).toBeTruthy();
      expect(claim.signal.aborted).toBe(true);
      expect(claim.signal.reason).toEqual(expect.objectContaining({ reason }));
      expect(
        store.append('user', 'session', context.id, claim.id, {
          role: 'assistant',
          content: 'late',
        }),
      ).toBeNull();
      expect(store.get('user', 'session', context.id, NOW)).toBeNull();
      expect(store.end('user', 'session', context.id)).toBe(false);
      store.onModuleDestroy();
    },
  );

  it('forwards client cancellation and removes the listener when the claim is released', () => {
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const client = new AbortController();
    const claim = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request',
      client.signal,
      NOW,
    );
    if (!claim) throw new Error('Expected a generation claim');
    client.abort(new Error('synthetic-client-cancel'));
    expect(claim.signal.aborted).toBe(true);
    expect(claim.signal.reason).toEqual(
      expect.objectContaining({ message: 'synthetic-client-cancel' }),
    );
    expect(store.releaseGeneration('user', 'session', context.id, claim.id)).toBe(true);
    store.onModuleDestroy();
  });

  it('periodically expires contexts, aborts active work, and releases its timer on destroy', () => {
    jest.useFakeTimers({ now: NOW });
    setLimits({
      INCOGNITO_CONTEXT_TTL_SECONDS: 1,
      INCOGNITO_CONTEXT_CLEANUP_INTERVAL_MS: 100,
    });
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const claim = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request',
      new AbortController().signal,
      NOW,
    );
    if (!claim) throw new Error('Expected a generation claim');
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(1_100);
    expect(claim.signal.aborted).toBe(true);
    expect(claim.signal.reason).toBeInstanceOf(IncognitoContextTerminatedError);
    expect(claim.signal.reason).toEqual(expect.objectContaining({ reason: 'expired' }));
    expect(store.get('user', 'session', context.id)).toBeNull();
    store.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('purges expired capacity before admitting a new context', () => {
    setLimits({
      INCOGNITO_CONTEXT_TTL_SECONDS: 1,
      INCOGNITO_CONTEXT_MAX_GLOBAL: 1,
      INCOGNITO_CONTEXT_MAX_PER_USER: 1,
      INCOGNITO_CONTEXT_MAX_PER_SESSION: 1,
    });
    const store = new InMemoryIncognitoContextStore();
    const expired = store.create('user', 'session', sessionExpiry(), NOW);
    const later = new Date(NOW.getTime() + 1_001);
    const replacement = store.create('user', 'session', sessionExpiry(), later);
    expect(replacement.id).not.toBe(expired.id);
    expect(store.get('user', 'session', expired.id, later)).toBeNull();
    store.onModuleDestroy();
  });

  it('does not create a claim for a missing or non-owned context', () => {
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    expect(
      store.claimGeneration(
        'other-user',
        'session',
        context.id,
        'request',
        new AbortController().signal,
        NOW,
      ),
    ).toBeNull();
    expect(
      store.claimGeneration(
        'user',
        'other-session',
        context.id,
        'request',
        new AbortController().signal,
        NOW,
      ),
    ).toBeNull();
    store.onModuleDestroy();
  });

  it('rejects an already-aborted signal before creating active generation state', () => {
    const store = new InMemoryIncognitoContextStore();
    const context = store.create('user', 'session', sessionExpiry(), NOW);
    const client = new AbortController();
    client.abort(new Error('synthetic-pre-claim-cancel'));
    expect(() =>
      store.claimGeneration('user', 'session', context.id, 'request', client.signal, NOW),
    ).toThrow('synthetic-pre-claim-cancel');
    const next = store.claimGeneration(
      'user',
      'session',
      context.id,
      'request-2',
      new AbortController().signal,
      NOW,
    );
    expect(next).not.toBeNull();
    store.onModuleDestroy();
  });

  it('uses typed limit failures for later application error mapping', () => {
    const error = new IncognitoContextLimitError('global_context_limit');
    expect(error).toMatchObject({
      name: 'IncognitoContextLimitError',
      reason: 'global_context_limit',
    });
  });
});
