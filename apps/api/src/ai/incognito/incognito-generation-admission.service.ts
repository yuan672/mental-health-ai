import { Inject, Injectable } from '@nestjs/common';
import {
  AIChatDisabledError,
  AIIncognitoContextLostError,
  AITurnInProgressError,
  RateLimitError,
  QuotaExceededError,
} from '../../common/errors';
import { env } from '../../config/env';
import { ConsentExecutionCoordinator } from '../../consents/runtime/consent-execution.coordinator';
import { QuotaService } from '../../quota/quota.service';
import {
  CrisisFlowService,
  type TrustedSafetyResponse,
} from '../../safety/crisis/crisis-flow.service';
import { RiskEventService } from '../../safety/persistence/risk-event.service';
import type { RiskDecision } from '../../safety/safety.types';
import { TrustedSafetyTemplateRegistry } from '../../safety/templates/trusted-safety-template.registry';
import { PRE_GENERATION_SAFETY_GATE, type PreGenerationSafetyGate } from '../safety/safety-gates';
import type { ConsentBoundExecution } from '../runtime/active-ai-execution.registry';
import {
  deriveIncognitoQuotaIdempotencyKey,
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContext,
  type IncognitoContextStore,
  type IncognitoGenerationClaim,
  IncognitoGenerationAlreadyClaimedError,
  IncognitoGenerationInProgressError,
  IncognitoContextLimitError,
} from './incognito-context.store';

export type IncognitoGenerationAdmission =
  | Readonly<{
      kind: 'generation';
      context: IncognitoContext;
      generation: IncognitoGenerationClaim;
      quotaIdempotencyKey: string;
      riskDecision: RiskDecision;
    }>
  | Readonly<{
      kind: 'trusted';
      context: IncognitoContext;
      generation: IncognitoGenerationClaim;
      response: TrustedSafetyResponse;
      riskDecision: RiskDecision;
    }>;

@Injectable()
export class IncognitoGenerationAdmissionService {
  constructor(
    private readonly consentExecutions: ConsentExecutionCoordinator,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly contexts: IncognitoContextStore,
    private readonly crisisFlow: CrisisFlowService,
    @Inject(PRE_GENERATION_SAFETY_GATE)
    private readonly preGenerationSafety: PreGenerationSafetyGate,
    private readonly quota: QuotaService,
    private readonly riskEvents: RiskEventService,
    private readonly templates: TrustedSafetyTemplateRegistry,
  ) {}

  async claim(input: {
    userId: string;
    sessionId: string;
    contextId: string;
    clientRequestId: string;
    message: string;
    signal: AbortSignal;
    execution: ConsentBoundExecution;
    now?: Date;
  }): Promise<IncognitoGenerationAdmission> {
    const now = input.now ?? new Date();
    if (!env.AI_CHAT_ENABLED) throw new AIChatDisabledError();

    let generation: IncognitoGenerationClaim | null;
    try {
      generation = this.contexts.claimGeneration(
        input.userId,
        input.sessionId,
        input.contextId,
        input.clientRequestId,
        input.signal,
        now,
      );
    } catch (error) {
      if (error instanceof IncognitoGenerationInProgressError) {
        throw new AITurnInProgressError('该无痕对话已有正在处理的 AI 回复');
      }
      if (error instanceof IncognitoGenerationAlreadyClaimedError) {
        throw new AIIncognitoContextLostError('该无痕请求已结束，请重新开始本轮请求');
      }
      if (error instanceof IncognitoContextLimitError) {
        throw new RateLimitError('无痕对话上下文已达到当前请求限制');
      }
      throw error;
    }
    if (!generation) throw new AIIncognitoContextLostError();

    try {
      await this.consentExecutions.assertStillUsable(input.execution);
      if (generation.signal.aborted) throw generation.signal.reason;

      const quotaIdempotencyKey = deriveIncognitoQuotaIdempotencyKey(
        input.userId,
        input.sessionId,
        input.clientRequestId,
      );
      if (await this.quota.hasConsumption(input.userId, quotaIdempotencyKey)) {
        throw new AIIncognitoContextLostError();
      }
      const context = this.contexts.get(input.userId, input.sessionId, input.contextId, now);
      if (!context) throw new AIIncognitoContextLostError();
      await this.consentExecutions.assertIncognitoDependencies(input.execution, context);
      if (generation.signal.aborted) throw generation.signal.reason;

      const quotaAvailable = await this.quota.canUseAI(input.userId, now);
      const riskDecision = await this.preGenerationSafety.check(
        {
          turnId: generation.id,
          userId: input.userId,
          target: {
            kind: 'incognito',
            contextId: input.contextId,
            sessionId: input.sessionId,
          },
          message: input.message,
          now,
        },
        generation.signal,
        input.execution,
      );

      const trusted = await this.resolveTrustedResponse(
        input,
        context,
        generation,
        riskDecision,
        quotaAvailable,
        now,
      );
      if (trusted) return trusted;

      await this.riskEvents.persistIncognito({
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        decision: riskDecision,
        now,
      });
      if (!quotaAvailable) throw new QuotaExceededError();

      const consumption = await this.quota.consumeQuotaOnce(input.userId, quotaIdempotencyKey, now);
      if (consumption.status === 'already_consumed') throw new AIIncognitoContextLostError();

      const currentContext = this.contexts.get(
        input.userId,
        input.sessionId,
        input.contextId,
        new Date(),
      );
      if (!currentContext) {
        try {
          await this.quota.refundQuota(input.userId, quotaIdempotencyKey, now);
        } catch {
          // Context loss is authoritative for this request. The consumption remains
          // idempotent and prevents the lost context from receiving a free replay.
        }
        throw new AIIncognitoContextLostError();
      }
      return {
        kind: 'generation',
        context: currentContext,
        generation,
        quotaIdempotencyKey,
        riskDecision,
      };
    } catch (error) {
      this.contexts.releaseGeneration(
        input.userId,
        input.sessionId,
        input.contextId,
        generation.id,
      );
      throw error;
    }
  }

  private async resolveTrustedResponse(
    input: { userId: string; clientRequestId: string; now?: Date },
    context: IncognitoContext,
    generation: IncognitoGenerationClaim,
    decision: RiskDecision,
    quotaAvailable: boolean,
    now: Date,
  ): Promise<Extract<IncognitoGenerationAdmission, { kind: 'trusted' }> | null> {
    let response: TrustedSafetyResponse | null = null;
    if (decision.status === 'unavailable') {
      response = this.toResponse(this.templates.get('classifier-unavailable'));
    } else if (decision.level === 'CRITICAL') {
      response = this.crisisFlow.build(decision.harmSubject);
    } else if (decision.level === 'HIGH' && !quotaAvailable) {
      response = this.toResponse(this.templates.get('high-quota-fallback'));
    }
    if (!response) return null;

    await this.riskEvents.persistIncognito({
      userId: input.userId,
      clientRequestId: input.clientRequestId,
      decision,
      response,
      now,
    });
    return { kind: 'trusted', context, generation, response, riskDecision: decision };
  }

  private toResponse(template: Readonly<{ key: string; version: string; content: string }>) {
    return {
      templateKey: template.key,
      templateVersion: template.version,
      content: template.content,
    };
  }
}
