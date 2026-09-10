import { Injectable } from '@nestjs/common';
import { DatabaseError, ValidationError } from '../../common/errors';
import type { TrustedSafetyResponse } from '../crisis/crisis-flow.service';
import { requiresRiskEvent, type RiskDecision } from '../safety.types';
import { RiskEventRepository, type RiskEventRecord } from './risk-event.repository';

@Injectable()
export class RiskEventService {
  constructor(private readonly repository: RiskEventRepository) {}

  async persistIncognito(input: {
    userId: string;
    clientRequestId: string;
    decision: RiskDecision;
    response?: TrustedSafetyResponse;
    now?: Date;
  }): Promise<RiskEventRecord | null> {
    if (!requiresRiskEvent(input.decision)) return null;
    try {
      return await this.repository.persist({
        userId: input.userId,
        conversationId: null,
        aiTurnId: null,
        triggerMessageId: null,
        clientRequestId: input.clientRequestId,
        isIncognito: true,
        decision: input.decision,
        createdAt: input.now ?? new Date(),
        ...(input.response
          ? {
              trustedAction: {
                action:
                  input.decision.level === 'CRITICAL'
                    ? ('crisis_flow_triggered' as const)
                    : ('trusted_safety_response_created' as const),
                templateKey: input.response.templateKey,
                templateVersion: input.response.templateVersion,
              },
            }
          : {}),
      });
    } catch {
      throw new DatabaseError();
    }
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new ValidationError('安全记录清理批次大小无效');
    }
    try {
      return await this.repository.purgeExpired(now, batchSize);
    } catch {
      throw new DatabaseError();
    }
  }
}
