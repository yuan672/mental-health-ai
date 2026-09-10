import type { ConsentType, RegistrationRequirement } from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { env, type AppEnvironment } from '../config/env';

export type ConsentDocumentApprovalStatus = 'draft' | 'test_fixture' | 'production_reviewed';

export type ConsentDocument = Readonly<{
  consentType: ConsentType;
  consentVersion: string;
  documentKey: string;
  documentRevision: string;
  displayKey: RegistrationRequirement['displayKey'];
  documentUrl: string;
  approvalStatus: ConsentDocumentApprovalStatus;
  effectiveFrom: Date;
  processingNoticeKey?: string;
}>;

const SYNTHETIC_DOCUMENTS: readonly ConsentDocument[] = [
  {
    consentType: 'terms_of_service',
    consentVersion: '1.0',
    documentKey: 'synthetic.terms-of-service',
    documentRevision: 'test-revision-1',
    displayKey: 'consent.termsOfService',
    documentUrl: 'https://example.invalid/mental-health-ai/synthetic/terms/1.0',
    approvalStatus: 'test_fixture',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  },
  {
    consentType: 'privacy_policy',
    consentVersion: '1.0',
    documentKey: 'synthetic.privacy-policy',
    documentRevision: 'test-revision-1',
    displayKey: 'consent.privacyPolicy',
    documentUrl: 'https://example.invalid/mental-health-ai/synthetic/privacy/1.0',
    approvalStatus: 'test_fixture',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    processingNoticeKey: 'synthetic.third-party-ai-processing',
  },
];

function isEnvironmentEligible(
  document: ConsentDocument,
  appEnvironment: AppEnvironment['APP_ENV'],
): boolean {
  if (appEnvironment === 'development' || appEnvironment === 'test') {
    return document.approvalStatus === 'test_fixture';
  }
  return document.approvalStatus === 'production_reviewed';
}

@Injectable()
export class ConsentDocumentRegistry {
  constructor(
    private readonly appEnvironment: AppEnvironment['APP_ENV'] = env.APP_ENV,
    private readonly documents: readonly ConsentDocument[] = SYNTHETIC_DOCUMENTS,
  ) {}

  findEligible(
    consentType: ConsentType,
    consentVersion: string,
    now = new Date(),
  ): ConsentDocument | null {
    const matches = this.documents.filter(
      (document) =>
        document.consentType === consentType &&
        document.consentVersion === consentVersion &&
        document.effectiveFrom.getTime() <= now.getTime() &&
        isEnvironmentEligible(document, this.appEnvironment),
    );
    if (matches.length > 1) {
      return null;
    }
    return matches[0] ?? null;
  }

  matchesEligible(input: {
    consentType: ConsentType;
    consentVersion: string;
    documentKey: string;
    documentRevision: string;
  }): ConsentDocument | null {
    const document = this.findEligible(input.consentType, input.consentVersion);
    return document?.documentKey === input.documentKey &&
      document.documentRevision === input.documentRevision
      ? document
      : null;
  }

  findVerifiedDocument(
    consentType: ConsentType,
    consentVersion: string,
    documentKey: string | null,
    documentRevision: string | null,
  ): ConsentDocument | null {
    if (!documentKey || !documentRevision) {
      return null;
    }
    return (
      this.documents.find(
        (document) =>
          document.consentType === consentType &&
          document.consentVersion === consentVersion &&
          document.documentKey === documentKey &&
          document.documentRevision === documentRevision,
      ) ?? null
    );
  }
}
