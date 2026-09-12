import { Inject, Injectable } from '@nestjs/common';
import { AuthorizationError, ConflictError, DatabaseError } from '../../common/errors';
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

export const reviewResolutionCodeSchema = z.enum([
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
    const transactionAuthorization = this.authorizer.authorizeWithinTransaction
      ? (transaction: import('@mental-health/database').AppTransaction) =>
          this.authorizer.authorizeWithinTransaction!(transaction, principal, 'risk_event:read')
      : undefined;
    if (!transactionAuthorization) await this.authorizer.authorize(principal, 'risk_event:read');
    try {
      return await this.repository.findContextByRiskEventIdForReviewer(
        riskEventId,
        principal.id,
        now,
        transactionAuthorization,
      );
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new DatabaseError();
    }
  }

  async claim(
    principal: ReviewerPrincipal,
    itemId: string,
    now = new Date(),
  ): Promise<HumanReviewQueueRecord> {
    const transactionAuthorization = this.authorizer.authorizeWithinTransaction
      ? (transaction: import('@mental-health/database').AppTransaction) =>
          this.authorizer.authorizeWithinTransaction!(transaction, principal, 'review_queue:claim')
      : undefined;
    if (!transactionAuthorization) await this.authorizer.authorize(principal, 'review_queue:claim');
    try {
      const item = await this.repository.claim(itemId, principal.id, now, transactionAuthorization);
      if (!item) throw new ConflictError('审核项当前无法认领');
      return item;
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof ConflictError) throw error;
      throw new DatabaseError();
    }
  }

  async resolve(
    principal: ReviewerPrincipal,
    itemId: string,
    resolutionCode: string,
    now = new Date(),
  ): Promise<HumanReviewQueueRecord> {
    const transactionAuthorization = this.authorizer.authorizeWithinTransaction
      ? (transaction: import('@mental-health/database').AppTransaction) =>
          this.authorizer.authorizeWithinTransaction!(
            transaction,
            principal,
            'review_queue:resolve',
          )
      : undefined;
    if (!transactionAuthorization)
      await this.authorizer.authorize(principal, 'review_queue:resolve');
    const parsedResolution = reviewResolutionCodeSchema.parse(resolutionCode);
    try {
      const item = await this.repository.resolve(
        itemId,
        principal.id,
        parsedResolution,
        now,
        transactionAuthorization,
      );
      if (!item) throw new ConflictError('审核项当前无法完成');
      return item;
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof ConflictError) throw error;
      throw new DatabaseError();
    }
  }
}
