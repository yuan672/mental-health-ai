import { Injectable } from '@nestjs/common';
import { ConsentRequiredError, DatabaseError } from '../../common/errors';
import { ConsentLifecycleRepository } from '../consent-lifecycle.repository';
import { ConsentPolicyService } from '../consent-policy.service';
import type { ConsentDependency, ConsentPolicyKey } from './consent-execution.types';

export const CONSENT_AUTHORIZATION_SNAPSHOT = Symbol('CONSENT_AUTHORIZATION_SNAPSHOT');

export interface ConsentAuthorizationSnapshotPort {
  requiredPolicyKeys(): readonly ConsentPolicyKey[];
  loadRequiredDependencies(userId: string): Promise<readonly ConsentDependency[]>;
  dependenciesRemainActive(
    userId: string,
    dependencies: readonly ConsentDependency[],
  ): Promise<boolean>;
}

@Injectable()
export class LedgerConsentAuthorizationSnapshotAdapter implements ConsentAuthorizationSnapshotPort {
  constructor(
    private readonly policies: ConsentPolicyService,
    private readonly lifecycle: ConsentLifecycleRepository,
  ) {}

  requiredPolicyKeys(): readonly ConsentPolicyKey[] {
    return this.policies.getRequiredPolicies();
  }

  async loadRequiredDependencies(userId: string): Promise<readonly ConsentDependency[]> {
    try {
      return await Promise.all(
        this.policies.getRequiredPolicies().map(async (policy) => {
          const document = this.policies
            .getDocumentRegistry()
            .findEligible(policy.consentType, policy.consentVersion);
          const projection = await this.lifecycle.findProjection(
            userId,
            policy.consentType,
            policy.consentVersion,
          );
          const acceptance = projection
            ? await this.lifecycle.findEffectiveAcceptance(
                userId,
                policy.consentType,
                policy.consentVersion,
              )
            : null;
          if (
            !document ||
            projection?.status !== 'accepted' ||
            !acceptance ||
            acceptance.documentKey !== document.documentKey ||
            acceptance.documentRevision !== document.documentRevision
          ) {
            throw new ConsentRequiredError();
          }
          return {
            consentId: projection.id,
            acceptanceDecisionId: acceptance.id,
            stateRevision: projection.stateRevision,
            consentType: policy.consentType,
            consentVersion: policy.consentVersion,
          } satisfies ConsentDependency;
        }),
      );
    } catch (error) {
      if (error instanceof ConsentRequiredError) throw error;
      throw new DatabaseError();
    }
  }

  async dependenciesRemainActive(
    userId: string,
    dependencies: readonly ConsentDependency[],
  ): Promise<boolean> {
    try {
      const current = await this.loadRequiredDependencies(userId);
      if (current.length !== dependencies.length) return false;
      return dependencies.every((dependency) =>
        current.some(
          (candidate) =>
            candidate.consentId === dependency.consentId &&
            candidate.acceptanceDecisionId === dependency.acceptanceDecisionId &&
            candidate.stateRevision === dependency.stateRevision &&
            candidate.consentType === dependency.consentType &&
            candidate.consentVersion === dependency.consentVersion,
        ),
      );
    } catch {
      return false;
    }
  }
}
