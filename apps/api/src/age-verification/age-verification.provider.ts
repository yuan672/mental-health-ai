export const AGE_VERIFICATION_PROVIDER = Symbol('AGE_VERIFICATION_PROVIDER');

export type AgeVerificationInput = {
  candidateUserId: string;
  evidenceToken: string;
};

export type AgeVerificationResult = {
  verified: boolean;
  method: string;
  verifiedAt: Date;
};

export interface AgeVerificationProvider {
  verify(input: AgeVerificationInput): Promise<AgeVerificationResult>;
  healthCheck(): Promise<boolean>;
}

export class AgeVerificationProviderUnavailableError extends Error {
  constructor() {
    super('Age verification provider unavailable');
    this.name = AgeVerificationProviderUnavailableError.name;
  }
}

export class UnconfiguredAgeVerificationProvider implements AgeVerificationProvider {
  verify(): Promise<AgeVerificationResult> {
    return Promise.reject(new AgeVerificationProviderUnavailableError());
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}
