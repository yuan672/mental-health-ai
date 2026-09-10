import type {
  RegistrationRequirement,
  RegistrationRequirementsResponse,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { RegistrationUnavailableError } from '../common/errors';
import { env, type AppEnvironment } from '../config/env';
import { ConsentPolicyService } from '../consents/consent-policy.service';

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
    const documents = this.consentPolicy.getRequiredDocuments();
    const documentsAvailable = documents.every((document) => document !== null);
    const requiredConsents = documentsAvailable
      ? documents.map((document) => {
          if (!document) {
            throw new RegistrationUnavailableError();
          }
          return {
            type: document.consentType,
            version: document.consentVersion,
            displayKey: document.displayKey,
            documentKey: document.documentKey,
            documentRevision: document.documentRevision,
            documentUrl: document.documentUrl,
          } satisfies RegistrationRequirement;
        })
      : [];
    return {
      success: true,
      data: {
        registrationEnabled:
          documentsAvailable && isRegistrationEnabled(env.APP_ENV, env.AGE_VERIFICATION_PROVIDER),
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
