import { randomUUID } from 'node:crypto';
import type { ConsentType } from '@mental-health/types';
import { Injectable, Optional } from '@nestjs/common';
import { ConsentRequiredError } from '../common/errors';
import { env } from '../config/env';
import type { RegistrationConsent } from '../users/users.repository';
import { ConsentDocumentRegistry } from './consent-document.registry';

export const CONSENT_TYPES = {
  TERMS_OF_SERVICE: 'terms_of_service',
  PRIVACY_POLICY: 'privacy_policy',
} as const satisfies Record<string, ConsentType>;

export const CONSENT_TYPE_VALUES = [
  CONSENT_TYPES.TERMS_OF_SERVICE,
  CONSENT_TYPES.PRIVACY_POLICY,
] as const;

export type RequiredConsentPolicy = Readonly<{
  consentType: ConsentType;
  consentVersion: string;
}>;

export type RequiredConsentInput = {
  consentType: string;
  consentVersion: string;
  accepted: true;
  documentKey: string;
  documentRevision: string;
};

@Injectable()
export class ConsentPolicyService {
  private readonly documentRegistry: ConsentDocumentRegistry;
  private readonly requiredPolicies: readonly RequiredConsentPolicy[] = [
    {
      consentType: CONSENT_TYPES.TERMS_OF_SERVICE,
      consentVersion: env.REQUIRED_TERMS_VERSION,
    },
    {
      consentType: CONSENT_TYPES.PRIVACY_POLICY,
      consentVersion: env.REQUIRED_PRIVACY_VERSION,
    },
  ];

  constructor(@Optional() documentRegistry?: ConsentDocumentRegistry) {
    this.documentRegistry = documentRegistry ?? new ConsentDocumentRegistry();
  }

  prepareRequiredConsents(input: RequiredConsentInput[], acceptedAt: Date): RegistrationConsent[] {
    const submitted = new Map(
      input.map((consent) => [`${consent.consentType}:${consent.consentVersion}`, consent]),
    );

    if (
      submitted.size !== this.requiredPolicies.length ||
      !this.requiredPolicies.every((policy) => {
        const submission = submitted.get(`${policy.consentType}:${policy.consentVersion}`);
        return (
          submission?.accepted === true &&
          this.documentRegistry.matchesEligible({
            ...policy,
            documentKey: submission.documentKey,
            documentRevision: submission.documentRevision,
          }) !== null
        );
      })
    ) {
      throw new ConsentRequiredError();
    }

    return this.requiredPolicies.map((policy) => {
      const submission = submitted.get(`${policy.consentType}:${policy.consentVersion}`);
      if (!submission) {
        throw new ConsentRequiredError();
      }
      return {
        id: randomUUID(),
        decisionId: randomUUID(),
        operationId: randomUUID(),
        ...policy,
        documentKey: submission.documentKey,
        documentRevision: submission.documentRevision,
        acceptedAt,
      };
    });
  }

  getRequiredPolicies(): readonly RequiredConsentPolicy[] {
    return this.requiredPolicies;
  }

  getRequiredDocuments() {
    return this.requiredPolicies.map((policy) =>
      this.documentRegistry.findEligible(policy.consentType, policy.consentVersion),
    );
  }

  getDocumentRegistry(): ConsentDocumentRegistry {
    return this.documentRegistry;
  }

  isKnownConsentType(consentType: string): consentType is ConsentType {
    return CONSENT_TYPE_VALUES.some((knownType) => knownType === consentType);
  }

  isCurrentRequiredPolicy(consentType: ConsentType, consentVersion: string): boolean {
    return this.requiredPolicies.some(
      (policy) => policy.consentType === consentType && policy.consentVersion === consentVersion,
    );
  }
}
