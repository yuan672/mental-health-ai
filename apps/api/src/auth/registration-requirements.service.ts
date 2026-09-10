import type {
  RegistrationRequirement,
  RegistrationRequirementsResponse,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { RegistrationUnavailableError } from '../common/errors';
import { env, type AppEnvironment } from '../config/env';
import { CONSENT_TYPES, ConsentPolicyService } from '../consents/consent-policy.service';

const DISPLAY_KEYS: Readonly<Record<string, RegistrationRequirement['displayKey']>> = {
  [CONSENT_TYPES.TERMS_OF_SERVICE]: 'consent.termsOfService',
  [CONSENT_TYPES.PRIVACY_POLICY]: 'consent.privacyPolicy',
};

export function isRegistrationEnabled(
  appEnvironment: AppEnvironment['APP_ENV'],
  provider: AppEnvironment['AGE_VERIFICATION_PROVIDER'],
): boolean {
  return (appEnvironment === 'development' || appEnvironment === 'test') && provider === 'mock';
}

@Injectable()
export class RegistrationRequirementsService {
  constructor(private readonly consentPolicy: ConsentPolicyService) {}

  get(): RegistrationRequirementsResponse {
    const requiredConsents = this.consentPolicy.getRequiredPolicies().map((policy) => {
      const displayKey = DISPLAY_KEYS[policy.consentType];
      if (!displayKey) {
        throw new RegistrationUnavailableError();
      }
      return {
        type: policy.consentType as RegistrationRequirement['type'],
        version: policy.consentVersion,
        displayKey,
      };
    });

    return {
      success: true,
      data: {
        registrationEnabled: isRegistrationEnabled(env.APP_ENV, env.AGE_VERIFICATION_PROVIDER),
        minimumAge: 18,
        requiredConsents,
      },
    };
  }

  ensureEnabled(): void {
    if (!this.get().data.registrationEnabled) {
      throw new RegistrationUnavailableError();
    }
  }
}
