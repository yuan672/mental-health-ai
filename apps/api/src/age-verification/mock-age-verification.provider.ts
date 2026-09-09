import { Injectable } from '@nestjs/common';
import {
  AgeVerificationProviderUnavailableError,
  type AgeVerificationInput,
  type AgeVerificationProvider,
  type AgeVerificationResult,
} from './age-verification.provider';

@Injectable()
export class MockAgeVerificationProvider implements AgeVerificationProvider {
  async verify(input: AgeVerificationInput): Promise<AgeVerificationResult> {
    if (input.evidenceToken === 'mock-provider-error') {
      throw new AgeVerificationProviderUnavailableError();
    }

    return {
      verified: input.evidenceToken === 'mock-adult',
      method: 'mock',
      verifiedAt: new Date(),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
