import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, DatabaseError } from '../../common/errors';
import { z } from 'zod';
import {
  SAFETY_REVIEWER_AUTHORIZER,
  type ReviewerPrincipal,
  type SafetyReviewerAuthorizer,
} from './safety-reviewer-authorizer';
import {
  HumanReviewQueueRepository,
  type HumanReviewContext,
  type HumanReviewQueueRecord,
} from './human-review-queue.repository';

const resolutionCodeSchema = z.enum([
  'confirmed_risk',
  'false_positive',
  'unable_to_determine',
  'action_recorded',
]);

@Injectable()
export class HumanReviewQueueService {
  constructor(
    @Inject(SAFETY_REVIEWER_AUTHORIZER)
    private readonly authorizer: SafetyReviewerAuthorizer,
    private readonly repository: HumanReviewQueueRepository,
  ) {}

  async get(
    principal: ReviewerPrincipal,
    riskEventId: string,
    now = new Date(),
  ): Promise<HumanReviewContext | null> {
    await this.authorizer.authorize(principal, 'risk_event:read');
    try {
      return await this.repository.findContextByRiskEventIdForReviewer(
        riskEventId,
        principal.id,
        now,
      );
    } catch {
      throw new DatabaseError();
    }
  }

  async claim(
    principal: ReviewerPrincipal,
    itemId: string,
    now = new Date(),
  ): Promise<HumanReviewQueueRecord> {
    await this.authorizer.authorize(principal, 'review_queue:claim');
    try {
      const item = await this.repository.claim(itemId, principal.id, now);
      if (!item) throw new ConflictError('审核项当前无法认领');
      return item;
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      throw new DatabaseError();
    }
  }

  async resolve(
    principal: ReviewerPrincipal,
    itemId: string,
    resolutionCode: string,
    now = new Date(),
  ): Promise<HumanReviewQueueRecord> {
    await this.authorizer.authorize(principal, 'review_queue:resolve');
    const parsedResolution = resolutionCodeSchema.parse(resolutionCode);
    try {
      const item = await this.repository.resolve(itemId, principal.id, parsedResolution, now);
      if (!item) throw new ConflictError('审核项当前无法完成');
      return item;
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      throw new DatabaseError();
    }
  }
}
