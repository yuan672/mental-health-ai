import { Inject, Injectable } from '@nestjs/common';
import type { SessionRecord } from '../../users/users.repository';
import {
  AIChatDisabledError,
  AIProviderTimeoutError,
  AuthenticationError,
  RateLimitError,
} from '../../common/errors';
import { env } from '../../config/env';
import { ConsentExecutionCoordinator } from '../../consents/runtime/consent-execution.coordinator';
import { AiExecutionTotalTimeoutError } from '../runtime/active-ai-execution.registry';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContext,
  type IncognitoContextStore,
  IncognitoContextLimitError,
  IncognitoSessionExpiredError,
} from './incognito-context.store';

@Injectable()
export class IncognitoContextsService {
  constructor(
    private readonly consentExecutions: ConsentExecutionCoordinator,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly contexts: IncognitoContextStore,
  ) {}

  async create(session: SessionRecord, now = new Date()): Promise<IncognitoContext> {
    if (!env.AI_CHAT_ENABLED) throw new AIChatDisabledError();
    try {
      const controller = new AbortController();
      return await this.consentExecutions.createIncognitoContext({
        userId: session.userId,
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt,
        signal: controller.signal,
        deadlineAt: new Date(Date.now() + env.LLM_TOTAL_TIMEOUT_MS),
        now,
      });
    } catch (error) {
      if (error instanceof IncognitoContextLimitError) {
        throw new RateLimitError('无痕对话上下文数量已达到当前限制');
      }
      if (error instanceof IncognitoSessionExpiredError) {
        throw new AuthenticationError('登录已失效，请重新登录');
      }
      if (error instanceof AiExecutionTotalTimeoutError) {
        throw new AIProviderTimeoutError();
      }
      throw error;
    }
  }

  end(session: SessionRecord, contextId: string): void {
    this.contexts.end(session.userId, session.id, contextId);
  }
}
