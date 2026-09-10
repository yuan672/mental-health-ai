import { createHash, randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../../config/env';
import type { ConsentDependency } from '../../consents/runtime/consent-execution.types';

export const INCOGNITO_CONTEXT_STORE = Symbol('INCOGNITO_CONTEXT_STORE');

export function deriveIncognitoQuotaIdempotencyKey(
  userId: string,
  sessionId: string,
  clientRequestId: string,
): string {
  return createHash('sha256')
    .update(userId, 'utf8')
    .update('\0', 'utf8')
    .update(sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(clientRequestId, 'utf8')
    .digest('hex');
}

export type IncognitoContextMessage = Readonly<{
  role: 'user' | 'assistant';
  content: string;
}>;

export type IncognitoContext = Readonly<{
  id: string;
  userId: string;
  sessionId: string;
  messages: readonly IncognitoContextMessage[];
  consentDependencies: readonly ConsentDependency[];
  expiresAt: Date;
}>;

export type IncognitoContextLimitReason =
  | 'global_context_limit'
  | 'user_context_limit'
  | 'session_context_limit'
  | 'context_request_limit'
  | 'message_too_large'
  | 'context_message_limit'
  | 'context_character_limit';

export class IncognitoContextLimitError extends Error {
  constructor(public readonly reason: IncognitoContextLimitReason) {
    super(`Incognito context limit reached: ${reason}`);
    this.name = IncognitoContextLimitError.name;
  }
}

export class IncognitoGenerationInProgressError extends Error {
  constructor() {
    super('An Incognito generation is already active for this context');
    this.name = IncognitoGenerationInProgressError.name;
  }
}

export class IncognitoGenerationAlreadyClaimedError extends Error {
  constructor() {
    super('This Incognito client request has already been claimed');
    this.name = IncognitoGenerationAlreadyClaimedError.name;
  }
}

export class IncognitoSessionExpiredError extends Error {
  constructor() {
    super('The authenticated session has already expired');
    this.name = IncognitoSessionExpiredError.name;
  }
}

export type IncognitoContextTerminationReason =
  | 'expired'
  | 'ended'
  | 'session_cleared'
  | 'user_cleared'
  | 'consent_withdrawn'
  | 'module_destroyed';

export class IncognitoContextTerminatedError extends Error {
  constructor(public readonly reason: IncognitoContextTerminationReason) {
    super(`Incognito context terminated: ${reason}`);
    this.name = IncognitoContextTerminatedError.name;
  }
}

export type IncognitoGenerationClaim = Readonly<{
  id: string;
  contextId: string;
  clientRequestId: string;
  signal: AbortSignal;
}>;

export interface IncognitoContextStore {
  create(
    userId: string,
    sessionId: string,
    sessionExpiresAt: Date,
    consentDependencies: readonly ConsentDependency[],
    now?: Date,
  ): IncognitoContext;
  get(userId: string, sessionId: string, contextId: string, now?: Date): IncognitoContext | null;
  claimGeneration(
    userId: string,
    sessionId: string,
    contextId: string,
    clientRequestId: string,
    clientSignal: AbortSignal,
    now?: Date,
  ): IncognitoGenerationClaim | null;
  append(
    userId: string,
    sessionId: string,
    contextId: string,
    generationId: string,
    message: IncognitoContextMessage,
    now?: Date,
  ): IncognitoContext | null;
  releaseGeneration(
    userId: string,
    sessionId: string,
    contextId: string,
    generationId: string,
  ): boolean;
  end(userId: string, sessionId: string, contextId: string): boolean;
  clearSession(userId: string, sessionId: string): number;
  clearUser(userId: string): number;
  clearDependency(userId: string, acceptanceDecisionId: string): number;
  hasDependency(acceptanceDecisionId: string): boolean;
  purgeExpired(now?: Date): number;
}

type MutableActiveGeneration = {
  id: string;
  clientRequestId: string;
  controller: AbortController;
  clientSignal: AbortSignal;
  onClientAbort: () => void;
};

type MutableContext = {
  id: string;
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  messages: IncognitoContextMessage[];
  consentDependencies: ConsentDependency[];
  characterCount: number;
  usedClientRequestIds: Set<string>;
  expiresAt: Date;
  activeGeneration: MutableActiveGeneration | null;
};

@Injectable()
export class InMemoryIncognitoContextStore implements IncognitoContextStore, OnModuleDestroy {
  private readonly contexts = new Map<string, MutableContext>();
  private readonly ttlMilliseconds = env.INCOGNITO_CONTEXT_TTL_SECONDS * 1000;
  private readonly cleanupTimer = setInterval(
    () => this.purgeExpired(),
    env.INCOGNITO_CONTEXT_CLEANUP_INTERVAL_MS,
  );

  constructor() {
    this.cleanupTimer.unref();
  }

  create(
    userId: string,
    sessionId: string,
    sessionExpiresAt: Date,
    consentDependencies: readonly ConsentDependency[],
    now?: Date,
  ): IncognitoContext;
  create(
    userId: string,
    sessionId: string,
    sessionExpiresAt: Date,
    dependencies: readonly ConsentDependency[],
    now = new Date(),
  ): IncognitoContext {
    if (sessionExpiresAt.getTime() <= now.getTime()) {
      throw new IncognitoSessionExpiredError();
    }
    this.purgeExpired(now);
    this.assertContextCapacity(userId, sessionId);

    const id = randomUUID();
    const context: MutableContext = {
      id,
      userId,
      sessionId,
      sessionExpiresAt: new Date(sessionExpiresAt),
      messages: [],
      consentDependencies: dependencies.map((dependency) => ({ ...dependency })),
      characterCount: 0,
      usedClientRequestIds: new Set(),
      expiresAt: this.nextExpiry(now, sessionExpiresAt),
      activeGeneration: null,
    };
    this.contexts.set(id, context);
    return this.snapshot(context);
  }

  get(
    userId: string,
    sessionId: string,
    contextId: string,
    now = new Date(),
  ): IncognitoContext | null {
    const context = this.getOwnedActiveContext(userId, sessionId, contextId, now);
    return context ? this.snapshot(context) : null;
  }

  claimGeneration(
    userId: string,
    sessionId: string,
    contextId: string,
    clientRequestId: string,
    clientSignal: AbortSignal,
    now = new Date(),
  ): IncognitoGenerationClaim | null {
    const context = this.getOwnedActiveContext(userId, sessionId, contextId, now);
    if (!context) return null;
    if (context.activeGeneration) throw new IncognitoGenerationInProgressError();
    if (context.usedClientRequestIds.has(clientRequestId)) {
      throw new IncognitoGenerationAlreadyClaimedError();
    }
    if (context.usedClientRequestIds.size >= env.INCOGNITO_CONTEXT_MAX_REQUESTS) {
      throw new IncognitoContextLimitError('context_request_limit');
    }
    if (clientSignal.aborted) {
      throw clientSignal.reason ?? new Error('Incognito generation aborted before claim');
    }

    const controller = new AbortController();
    const onClientAbort = (): void =>
      controller.abort(clientSignal.reason ?? new Error('Incognito generation aborted'));
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
    const active: MutableActiveGeneration = {
      id: randomUUID(),
      clientRequestId,
      controller,
      clientSignal,
      onClientAbort,
    };
    context.usedClientRequestIds.add(clientRequestId);
    context.activeGeneration = active;
    return this.generationSnapshot(contextId, active);
  }

  append(
    userId: string,
    sessionId: string,
    contextId: string,
    generationId: string,
    message: IncognitoContextMessage,
    now = new Date(),
  ): IncognitoContext | null {
    const context = this.getOwnedActiveContext(userId, sessionId, contextId, now);
    if (!context || context.activeGeneration?.id !== generationId) return null;

    const characters = countCharacters(message.content);
    if (characters > env.INCOGNITO_CONTEXT_MAX_MESSAGE_CHARACTERS) {
      throw new IncognitoContextLimitError('message_too_large');
    }
    if (context.messages.length >= env.INCOGNITO_CONTEXT_MAX_MESSAGES) {
      throw new IncognitoContextLimitError('context_message_limit');
    }
    if (context.characterCount + characters > env.INCOGNITO_CONTEXT_MAX_CHARACTERS) {
      throw new IncognitoContextLimitError('context_character_limit');
    }

    context.messages.push({ ...message });
    context.characterCount += characters;
    this.refreshExpiry(context, now);
    return this.snapshot(context);
  }

  releaseGeneration(
    userId: string,
    sessionId: string,
    contextId: string,
    generationId: string,
  ): boolean {
    const context = this.contexts.get(contextId);
    if (
      !context ||
      context.userId !== userId ||
      context.sessionId !== sessionId ||
      context.activeGeneration?.id !== generationId
    ) {
      return false;
    }
    this.detachActiveGeneration(context);
    return true;
  }

  end(userId: string, sessionId: string, contextId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context || context.userId !== userId || context.sessionId !== sessionId) {
      return false;
    }
    return this.terminateContext(contextId, 'ended');
  }

  clearSession(userId: string, sessionId: string): number {
    return this.clearMatching(
      (context) => context.userId === userId && context.sessionId === sessionId,
      'session_cleared',
    );
  }

  clearUser(userId: string): number {
    return this.clearMatching((context) => context.userId === userId, 'user_cleared');
  }

  clearDependency(userId: string, acceptanceDecisionId: string): number {
    return this.clearMatching(
      (context) =>
        context.userId === userId &&
        context.consentDependencies.some(
          (dependency) => dependency.acceptanceDecisionId === acceptanceDecisionId,
        ),
      'consent_withdrawn',
    );
  }

  hasDependency(acceptanceDecisionId: string): boolean {
    return [...this.contexts.values()].some((context) =>
      context.consentDependencies.some(
        (dependency) => dependency.acceptanceDecisionId === acceptanceDecisionId,
      ),
    );
  }

  purgeExpired(now = new Date()): number {
    let removed = 0;
    for (const [contextId, context] of this.contexts) {
      if (context.expiresAt.getTime() <= now.getTime()) {
        if (this.terminateContext(contextId, 'expired')) removed += 1;
      }
    }
    return removed;
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    this.clearMatching(() => true, 'module_destroyed');
  }

  private getOwnedActiveContext(
    userId: string,
    sessionId: string,
    contextId: string,
    now: Date,
  ): MutableContext | null {
    const context = this.contexts.get(contextId);
    if (!context || context.userId !== userId || context.sessionId !== sessionId) return null;
    if (context.expiresAt.getTime() <= now.getTime()) {
      this.terminateContext(contextId, 'expired');
      return null;
    }
    return context;
  }

  private assertContextCapacity(userId: string, sessionId: string): void {
    if (this.contexts.size >= env.INCOGNITO_CONTEXT_MAX_GLOBAL) {
      throw new IncognitoContextLimitError('global_context_limit');
    }

    let userContexts = 0;
    let sessionContexts = 0;
    for (const context of this.contexts.values()) {
      if (context.userId !== userId) continue;
      userContexts += 1;
      if (context.sessionId === sessionId) sessionContexts += 1;
    }
    if (userContexts >= env.INCOGNITO_CONTEXT_MAX_PER_USER) {
      throw new IncognitoContextLimitError('user_context_limit');
    }
    if (sessionContexts >= env.INCOGNITO_CONTEXT_MAX_PER_SESSION) {
      throw new IncognitoContextLimitError('session_context_limit');
    }
  }

  private clearMatching(
    matches: (context: MutableContext) => boolean,
    reason: IncognitoContextTerminationReason,
  ): number {
    let removed = 0;
    for (const [contextId, context] of this.contexts) {
      if (matches(context) && this.terminateContext(contextId, reason)) removed += 1;
    }
    return removed;
  }

  private terminateContext(contextId: string, reason: IncognitoContextTerminationReason): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;
    this.contexts.delete(contextId);
    const active = context.activeGeneration;
    this.detachActiveGeneration(context);
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new IncognitoContextTerminatedError(reason));
    }
    context.messages.length = 0;
    context.consentDependencies.length = 0;
    context.characterCount = 0;
    context.usedClientRequestIds.clear();
    return true;
  }

  private detachActiveGeneration(context: MutableContext): void {
    const active = context.activeGeneration;
    if (!active) return;
    active.clientSignal.removeEventListener('abort', active.onClientAbort);
    context.activeGeneration = null;
  }

  private refreshExpiry(context: MutableContext, now: Date): void {
    context.expiresAt = this.nextExpiry(now, context.sessionExpiresAt);
  }

  private nextExpiry(now: Date, sessionExpiresAt: Date): Date {
    return new Date(Math.min(now.getTime() + this.ttlMilliseconds, sessionExpiresAt.getTime()));
  }

  private generationSnapshot(
    contextId: string,
    active: MutableActiveGeneration,
  ): IncognitoGenerationClaim {
    return {
      id: active.id,
      contextId,
      clientRequestId: active.clientRequestId,
      signal: active.controller.signal,
    };
  }

  private snapshot(context: MutableContext): IncognitoContext {
    return {
      id: context.id,
      userId: context.userId,
      sessionId: context.sessionId,
      messages: context.messages.map((message) => ({ ...message })),
      consentDependencies: context.consentDependencies.map((dependency) => ({ ...dependency })),
      expiresAt: new Date(context.expiresAt),
    };
  }
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}
