import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConsentRequiredError } from '../common/errors';
import { env } from '../config/env';
import type { RegistrationConsent } from '../users/users.repository';

export const CONSENT_TYPES = {
  TERMS_OF_SERVICE: 'terms_of_service',
  PRIVACY_POLICY: 'privacy_policy',
} as const;

export type RequiredConsentInput = {
  consentType: string;
  consentVersion: string;
  accepted: true;
};

@Injectable()
export class ConsentPolicyService {
  private readonly requiredPolicies = [
    {
      consentType: CONSENT_TYPES.TERMS_OF_SERVICE,
      consentVersion: env.REQUIRED_TERMS_VERSION,
    },
    {
      consentType: CONSENT_TYPES.PRIVACY_POLICY,
      consentVersion: env.REQUIRED_PRIVACY_VERSION,
    },
  ];

  prepareRequiredConsents(input: RequiredConsentInput[], acceptedAt: Date): RegistrationConsent[] {
    const submitted = new Map(
      input.map((consent) => [
        `${consent.consentType}:${consent.consentVersion}`,
        consent.accepted,
      ]),
    );

    if (
      submitted.size !== this.requiredPolicies.length ||
      !this.requiredPolicies.every(
        (policy) => submitted.get(`${policy.consentType}:${policy.consentVersion}`) === true,
      )
    ) {
      throw new ConsentRequiredError();
    }

    return this.requiredPolicies.map((policy) => ({
      id: randomUUID(),
      ...policy,
      acceptedAt,
    }));
  }
}
