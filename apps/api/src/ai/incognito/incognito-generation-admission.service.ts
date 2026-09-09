import { Inject, Injectable } from '@nestjs/common';
import { AIChatDisabledError, AIIncognitoContextLostError } from '../../common/errors';
import { env } from '../../config/env';
import { ConsentsService } from '../../consents/consents.service';
import { QuotaService } from '../../quota/quota.service';
import { PRE_GENERATION_SAFETY_GATE, type PreGenerationSafetyGate } from '../safety/safety-gates';
import {
  deriveIncognitoQuotaIdempotencyKey,
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContext,
  type IncognitoContextStore,
} from './incognito-context.store';

export type IncognitoGenerationAdmission = Readonly<{
  context: IncognitoContext;
  quotaIdempotencyKey: string;
}>;

@Injectable()
export class IncognitoGenerationAdmissionService {
  constructor(
    private readonly consents: ConsentsService,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly contexts: IncognitoContextStore,
    @Inject(PRE_GENERATION_SAFETY_GATE)
    private readonly preGenerationSafety: PreGenerationSafetyGate,
    private readonly quota: QuotaService,
  ) {}

  async claim(input: {
    userId: string;
    sessionId: string;
    contextId: string;
    clientRequestId: string;
    message: string;
    signal: AbortSignal;
    now?: Date;
  }): Promise<IncognitoGenerationAdmission> {
    const now = input.now ?? new Date();
    if (!env.AI_CHAT_ENABLED) {
      throw new AIChatDisabledError();
    }
    await this.consents.ensureRequiredConsentsActive(input.userId);

    const quotaIdempotencyKey = deriveIncognitoQuotaIdempotencyKey(
      input.userId,
      input.sessionId,
      input.clientRequestId,
    );
    const existingContext = this.contexts.get(input.userId, input.sessionId, input.contextId, now);

    if (await this.quota.hasConsumption(input.userId, quotaIdempotencyKey)) {
      throw new AIIncognitoContextLostError();
    }
    if (!existingContext) {
      throw new AIIncognitoContextLostError();
    }
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    await this.preGenerationSafety.check(
      {
        userId: input.userId,
        target: { kind: 'incognito', contextId: input.contextId },
        message: input.message,
      },
      input.signal,
    );

    const consumption = await this.quota.consumeQuotaOnce(input.userId, quotaIdempotencyKey, now);
    if (consumption.status === 'already_consumed') {
      throw new AIIncognitoContextLostError();
    }

    const currentContext = this.contexts.get(input.userId, input.sessionId, input.contextId, now);
    if (!currentContext) {
      await this.quota.refundQuota(input.userId, quotaIdempotencyKey, now);
      throw new AIIncognitoContextLostError();
    }

    return { context: currentContext, quotaIdempotencyKey };
  }
}
