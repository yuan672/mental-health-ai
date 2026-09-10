export type ConsentType = 'terms_of_service' | 'privacy_policy';
export type ConsentStatus = 'accepted' | 'withdrawn';
export type RequiredConsentStatus = ConsentStatus | 'not_accepted';
export type ConsentMutationAction = 'accept' | 'withdraw';

export type ConsentHistoryItem = {
  consentType: ConsentType;
  consentVersion: string;
  status: ConsentStatus;
  acceptedAt: string;
  withdrawnAt: string | null;
};

export type ConsentHistoryResponse = {
  success: true;
  data: {
    currentRequiredConsents: Array<{
      consentType: ConsentType;
      consentVersion: string;
      status: RequiredConsentStatus;
      acceptedAt: string | null;
      withdrawnAt: string | null;
    }>;
    consents: ConsentHistoryItem[];
    nextCursor: string | null;
  };
};

export type ConsentMutationRequest = {
  consentType: ConsentType;
  consentVersion: string;
  action: ConsentMutationAction;
};

export type ConsentMutationResponse = {
  success: true;
  data: { consent: ConsentHistoryItem };
};
