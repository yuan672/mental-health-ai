import { Inject, Injectable } from '@nestjs/common';
import type { SessionRecord } from '../../users/users.repository';
import { AIChatDisabledError, AuthenticationError, RateLimitError } from '../../common/errors';
import { env } from '../../config/env';
import { ConsentsService } from '../../consents/consents.service';
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
    private readonly consents: ConsentsService,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly contexts: IncognitoContextStore,
  ) {}

  async create(session: SessionRecord, now = new Date()): Promise<IncognitoContext> {
    if (!env.AI_CHAT_ENABLED) throw new AIChatDisabledError();
    await this.consents.ensureRequiredConsentsActive(session.userId);
    try {
      return this.contexts.create(session.userId, session.id, session.expiresAt, now);
    } catch (error) {
      if (error instanceof IncognitoContextLimitError) {
        throw new RateLimitError('无痕对话上下文数量已达到当前限制');
      }
      if (error instanceof IncognitoSessionExpiredError) {
        throw new AuthenticationError('登录已失效，请重新登录');
      }
      throw error;
    }
  }

  end(session: SessionRecord, contextId: string): void {
    this.contexts.end(session.userId, session.id, contextId);
  }
}
