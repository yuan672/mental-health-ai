import { Injectable } from '@nestjs/common';
import { ConsentRequiredError, DatabaseError } from '../../common/errors';
import { UsersRepository, type ConsentRecord } from '../../users/users.repository';
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

/**
 * Compatibility adapter for the pre-ledger schema. The ADR-016 data implementation
 * replaces this provider with one backed by immutable acceptance decisions and
 * state revisions. Keeping the port here lets runtime coordination remain isolated
 * from the migration branch.
 */
@Injectable()
export class CurrentConsentAuthorizationSnapshotAdapter implements ConsentAuthorizationSnapshotPort {
  constructor(
    private readonly policies: ConsentPolicyService,
    private readonly users: UsersRepository,
  ) {}

  requiredPolicyKeys(): readonly ConsentPolicyKey[] {
    return this.policies.getRequiredPolicies();
  }

  async loadRequiredDependencies(userId: string): Promise<readonly ConsentDependency[]> {
    let records: ConsentRecord[];
    try {
      records = await this.users.listConsents(userId);
    } catch {
      throw new DatabaseError();
    }
    return this.dependenciesFromRecords(records);
  }

  async dependenciesRemainActive(
    userId: string,
    dependencies: readonly ConsentDependency[],
  ): Promise<boolean> {
    let records: ConsentRecord[];
    try {
      records = await this.users.listConsents(userId);
    } catch {
      throw new DatabaseError();
    }
    const current = this.dependenciesFromRecords(records);
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
  }

  private dependenciesFromRecords(records: ConsentRecord[]): readonly ConsentDependency[] {
    const dependencies = this.policies.getRequiredPolicies().map((policy) => {
      const record = records.find(
        (candidate) =>
          candidate.consentType === policy.consentType &&
          candidate.consentVersion === policy.consentVersion &&
          candidate.status === 'accepted',
      );
      if (!record) throw new ConsentRequiredError();
      return {
        consentId: record.id,
        acceptanceDecisionId: record.id,
        stateRevision: 1,
        consentType: policy.consentType,
        consentVersion: policy.consentVersion,
      };
    });
    return dependencies;
  }
}
