import type { ApiSuccessResponse } from './index.js';

export type StaffRole =
  | 'access_administrator'
  | 'safety_reviewer'
  | 'knowledge_editor'
  | 'knowledge_source_reviewer'
  | 'knowledge_publisher'
  | 'audit_reader'
  | 'ai_quality_reviewer';

export type StaffPrincipal = {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  authorizationRevision: number;
  roleKeys: StaffRole[];
  createdAt: string;
  disabledAt: string | null;
};

export type StaffSessionResponse = ApiSuccessResponse<{
  principal: {
    id: string;
    roleKeys: StaffRole[];
    authorizationRevision: number;
  };
  session: { id: string; expiresAt: string };
}>;

export type StaffPrincipalResponse = ApiSuccessResponse<{ principal: StaffPrincipal }>;
export type StaffPrincipalMutationResponse = ApiSuccessResponse<{
  outcome: 'applied' | 'no_change';
  principal: StaffPrincipal;
  sessionCount?: number;
}>;
export type StaffPrincipalListResponse = ApiSuccessResponse<{
  principals: StaffPrincipal[];
  nextCursor: string | null;
}>;

export type AdminRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AdminRiskCategory = 'SELF_HARM' | 'HARM_TO_OTHERS';
export type AdminRiskReasonCode =
  | 'SELF_HARM_IDEATION'
  | 'HARM_TO_OTHERS_IDEATION'
  | 'PASSIVE_DEATH_WISH'
  | 'CURRENT_FIRST_PERSON'
  | 'HISTORICAL_ONLY'
  | 'THIRD_PARTY_REPORT'
  | 'NEGATED_STATEMENT'
  | 'EXPLICIT_INTENT'
  | 'PLAN_PRESENT'
  | 'MEANS_AVAILABLE'
  | 'IMMEDIATE_TIMEFRAME'
  | 'ACT_IN_PROGRESS'
  | 'AMBIGUOUS_SAFETY_SIGNAL'
  | 'CLASSIFIER_HIGHER_THAN_RULES'
  | 'RULES_HIGHER_THAN_CLASSIFIER'
  | 'LOW_CLASSIFIER_CONFIDENCE';

export type AdminRiskEvent = {
  id: string;
  isIncognito: boolean;
  ordinaryContextReferenceAvailable: boolean;
  level: AdminRiskLevel;
  riskCategories: AdminRiskCategory[];
  reasonCodes: AdminRiskReasonCode[];
  detectionSource: 'deterministic' | 'classifier' | 'hybrid';
  policyVersion: string;
  classifierKey: string | null;
  classifierVersion: string | null;
  createdAt: string;
  retentionUntil: string;
};

export type AdminReviewResolutionCode =
  'confirmed_risk' | 'false_positive' | 'unable_to_determine' | 'action_recorded';

export type AdminReviewQueueItem = {
  id: string;
  riskEventId: string;
  priority: 'high' | 'urgent';
  state: 'pending' | 'in_review' | 'resolved';
  assignedReviewerId: string | null;
  createdAt: string;
  startedAt: string | null;
  reviewedAt: string | null;
  resolutionCode: AdminReviewResolutionCode | null;
};

export type AdminRiskEventListResponse = ApiSuccessResponse<{
  riskEvents: AdminRiskEvent[];
  nextCursor: string | null;
}>;
export type AdminRiskEventDetailResponse = ApiSuccessResponse<{
  riskEvent: AdminRiskEvent;
  reviewQueueItem: AdminReviewQueueItem | null;
}>;
export type AdminReviewQueueListResponse = ApiSuccessResponse<{
  queueItems: Array<{ queueItem: AdminReviewQueueItem; riskEvent: AdminRiskEvent }>;
  nextCursor: string | null;
}>;
export type AdminReviewQueueMutationResponse = ApiSuccessResponse<{
  queueItem: AdminReviewQueueItem;
}>;
