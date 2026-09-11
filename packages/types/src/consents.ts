export type ConsentType = 'terms_of_service' | 'privacy_policy';
export type ConsentStatus = 'accepted' | 'withdrawn';
export type ConsentAuthorizationStatus = 'active' | 'confirmation_required' | 'inactive';
export type ConsentMutationAction = 'accept' | 'withdraw';
export type ConsentDecisionOutcome = 'applied' | 'no_change';
export type ConsentDecisionSource = 'registration' | 'privacy_ui' | 'legacy_backfill';
export type ConsentDocumentEvidenceStatus = 'verified' | 'unavailable' | 'unmapped_legacy';

export type ConsentAcceptableDocument = {
  documentKey: string;
  documentRevision: string;
  documentUrl: string;
  displayKey: 'consent.termsOfService' | 'consent.privacyPolicy';
};

export type ConsentCurrentItem = {
  consentType: ConsentType;
  consentVersion: string;
  isCurrentRequired: boolean;
  status: ConsentStatus | 'not_accepted';
  stateRevision: number;
  effectiveAt: string | null;
  acceptedAt: string | null;
  withdrawnAt: string | null;
  documentKey: string | null;
  documentRevision: string | null;
  documentUrl: string | null;
  displayKey: 'consent.termsOfService' | 'consent.privacyPolicy';
  documentEvidenceStatus: ConsentDocumentEvidenceStatus;
  acceptableDocument: ConsentAcceptableDocument | null;
  authorizationStatus: ConsentAuthorizationStatus;
  acceptanceEnabled: boolean;
  withdrawalEnabled: boolean;
};

type ConsentDecisionReceiptBase = {
  operationId: string;
  outcome: ConsentDecisionOutcome;
  consentType: ConsentType;
  consentVersion: string;
  priorRevision: number;
  resultingRevision: number;
  occurredAt: string;
  decisionSource: ConsentDecisionSource;
};

export type ConsentAcceptanceReceipt = ConsentDecisionReceiptBase & {
  action: 'accept';
  documentKey: string | null;
  documentRevision: string | null;
  documentEvidenceStatus: ConsentDocumentEvidenceStatus;
};

export type ConsentWithdrawalReceipt = ConsentDecisionReceiptBase & {
  action: 'withdraw';
  targetDocumentKey: string | null;
  targetDocumentRevision: string | null;
  targetDocumentEvidenceStatus: ConsentDocumentEvidenceStatus;
};

export type ConsentDecisionReceipt = ConsentAcceptanceReceipt | ConsentWithdrawalReceipt;
export type ConsentHistoryItem = ConsentDecisionReceipt;

export type ConsentHistoryResponse = {
  success: true;
  data: {
    currentRequiredConsents: ConsentCurrentItem[];
    consentStates: ConsentCurrentItem[];
    consents: ConsentHistoryItem[];
    nextCursor: string | null;
  };
};

export type ConsentAcceptRequest = {
  operationId: string;
  action: 'accept';
  consentType: ConsentType;
  consentVersion: string;
  documentKey: string;
  documentRevision: string;
  expectedRevision: number;
};

export type ConsentWithdrawRequest = {
  operationId: string;
  action: 'withdraw';
  consentType: ConsentType;
  consentVersion: string;
  expectedRevision: number;
};

export type ConsentMutationRequest = ConsentAcceptRequest | ConsentWithdrawRequest;

export type ConsentMutationResponse = {
  success: true;
  data: {
    receipt: ConsentDecisionReceipt;
    current: ConsentCurrentItem;
  };
};
