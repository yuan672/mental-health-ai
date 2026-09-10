import { Inject, Injectable } from '@nestjs/common';
import type { SessionRecord } from '../../users/users.repository';
import { AIChatDisabledError } from '../../common/errors';
import { env } from '../../config/env';
import { ConsentsService } from '../../consents/consents.service';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContext,
  type IncognitoContextStore,
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
    return this.contexts.create(session.userId, session.id, session.expiresAt, now);
  }

  end(session: SessionRecord, contextId: string): void {
    this.contexts.end(session.userId, session.id, contextId);
  }
}
