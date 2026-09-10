import { Injectable } from '@nestjs/common';
import { AuthorizationError } from '../../common/errors';

export const SAFETY_REVIEWER_AUTHORIZER = Symbol('SAFETY_REVIEWER_AUTHORIZER');

export type ReviewerPrincipal = Readonly<{ id: string }>;
export type ReviewerPermission = 'risk_event:read' | 'review_queue:claim' | 'review_queue:resolve';

export interface SafetyReviewerAuthorizer {
  readonly productionReady: boolean;
  authorize(principal: ReviewerPrincipal, permission: ReviewerPermission): Promise<void>;
}

@Injectable()
export class DefaultDenySafetyReviewerAuthorizer implements SafetyReviewerAuthorizer {
  readonly productionReady = false;

  authorize(): Promise<void> {
    return Promise.reject(new AuthorizationError('安全审核权限尚未启用'));
  }
}
