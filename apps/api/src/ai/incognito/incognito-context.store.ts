import { createHash, randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../../config/env';
import type { LLMMessage } from '../providers/llm-provider';

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

export type IncognitoContext = Readonly<{
  id: string;
  userId: string;
  sessionId: string;
  messages: readonly LLMMessage[];
  expiresAt: Date;
}>;

export interface IncognitoContextStore {
  create(userId: string, sessionId: string, now?: Date): IncognitoContext;
  get(userId: string, sessionId: string, contextId: string, now?: Date): IncognitoContext | null;
  append(
    userId: string,
    sessionId: string,
    contextId: string,
    message: LLMMessage,
    now?: Date,
  ): IncognitoContext | null;
  end(userId: string, sessionId: string, contextId: string): boolean;
  clearSession(userId: string, sessionId: string): number;
  purgeExpired(now?: Date): number;
}

type MutableContext = {
  id: string;
  userId: string;
  sessionId: string;
  messages: LLMMessage[];
  expiresAt: Date;
  timer: NodeJS.Timeout;
};

@Injectable()
export class InMemoryIncognitoContextStore implements IncognitoContextStore, OnModuleDestroy {
  private readonly contexts = new Map<string, MutableContext>();
  private readonly ttlMilliseconds = env.INCOGNITO_CONTEXT_TTL_SECONDS * 1000;

  create(userId: string, sessionId: string, now = new Date()): IncognitoContext {
    const id = randomUUID();
    const context: MutableContext = {
      id,
      userId,
      sessionId,
      messages: [],
      expiresAt: new Date(now.getTime() + this.ttlMilliseconds),
      timer: this.scheduleExpiry(id, this.ttlMilliseconds),
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
    const context = this.contexts.get(contextId);
    if (!context || context.userId !== userId || context.sessionId !== sessionId) {
      return null;
    }
    if (context.expiresAt.getTime() <= now.getTime()) {
      this.deleteContext(contextId);
      return null;
    }
    return this.snapshot(context);
  }

  append(
    userId: string,
    sessionId: string,
    contextId: string,
    message: LLMMessage,
    now = new Date(),
  ): IncognitoContext | null {
    const context = this.contexts.get(contextId);
    if (!context || context.userId !== userId || context.sessionId !== sessionId) {
      return null;
    }
    if (context.expiresAt.getTime() <= now.getTime()) {
      this.deleteContext(contextId);
      return null;
    }

    context.messages.push({ ...message });
    context.expiresAt = new Date(now.getTime() + this.ttlMilliseconds);
    clearTimeout(context.timer);
    context.timer = this.scheduleExpiry(contextId, this.ttlMilliseconds);
    return this.snapshot(context);
  }

  end(userId: string, sessionId: string, contextId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context || context.userId !== userId || context.sessionId !== sessionId) {
      return false;
    }
    this.deleteContext(contextId);
    return true;
  }

  clearSession(userId: string, sessionId: string): number {
    let removed = 0;
    for (const [contextId, context] of this.contexts) {
      if (context.userId === userId && context.sessionId === sessionId) {
        this.deleteContext(contextId);
        removed += 1;
      }
    }
    return removed;
  }

  purgeExpired(now = new Date()): number {
    let removed = 0;
    for (const [contextId, context] of this.contexts) {
      if (context.expiresAt.getTime() <= now.getTime()) {
        this.deleteContext(contextId);
        removed += 1;
      }
    }
    return removed;
  }

  onModuleDestroy(): void {
    for (const context of this.contexts.values()) {
      clearTimeout(context.timer);
    }
    this.contexts.clear();
  }

  private scheduleExpiry(contextId: string, delay: number): NodeJS.Timeout {
    const timer = setTimeout(() => this.deleteContext(contextId), delay);
    timer.unref();
    return timer;
  }

  private deleteContext(contextId: string): void {
    const context = this.contexts.get(contextId);
    if (context) {
      clearTimeout(context.timer);
      this.contexts.delete(contextId);
    }
  }

  private snapshot(context: MutableContext): IncognitoContext {
    return {
      id: context.id,
      userId: context.userId,
      sessionId: context.sessionId,
      messages: context.messages.map((message) => ({ ...message })),
      expiresAt: new Date(context.expiresAt),
    };
  }
}
