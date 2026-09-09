import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConflictError, ConsentRequiredError, DatabaseError } from '../common/errors';
import { isPostgresUniqueViolation } from '../common/errors/postgres-error';
import { UsersRepository, type ConsentRecord } from '../users/users.repository';
import { ConsentPolicyService } from './consent-policy.service';

@Injectable()
export class ConsentsService {
  constructor(
    private readonly consentPolicy: ConsentPolicyService,
    private readonly usersRepository: UsersRepository,
  ) {}

  list(userId: string): Promise<ConsentRecord[]> {
    return this.usersRepository.listConsents(userId);
  }

  async ensureRequiredConsentsActive(userId: string): Promise<void> {
    let records: ConsentRecord[];
    try {
      records = await this.usersRepository.listConsents(userId);
    } catch {
      throw new DatabaseError();
    }

    const active = new Set(
      records
        .filter((record) => record.status === 'accepted')
        .map((record) => `${record.consentType}:${record.consentVersion}`),
    );
    const allRequired = this.consentPolicy
      .getRequiredPolicies()
      .every((policy) => active.has(`${policy.consentType}:${policy.consentVersion}`));
    if (!allRequired) {
      throw new ConsentRequiredError('请先接受当前版本的必要条款后再使用 AI 对话');
    }
  }

  async accept(
    userId: string,
    consentType: string,
    consentVersion: string,
  ): Promise<ConsentRecord> {
    const existing = await this.usersRepository.findConsent(userId, consentType, consentVersion);
    if (existing?.status === 'accepted') {
      return existing;
    }
    if (existing?.status === 'withdrawn') {
      throw new ConflictError('同一政策版本撤回后不能再次接受');
    }

    const consent: ConsentRecord = {
      id: randomUUID(),
      userId,
      consentType,
      consentVersion,
      status: 'accepted',
      acceptedAt: new Date(),
      withdrawnAt: null,
    };

    try {
      await this.usersRepository.createConsent(consent);
      return consent;
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError('该政策版本的授权状态已存在');
      }
      throw new DatabaseError();
    }
  }

  async withdraw(
    userId: string,
    consentType: string,
    consentVersion: string,
  ): Promise<ConsentRecord> {
    const existing = await this.usersRepository.findConsent(userId, consentType, consentVersion);
    if (!existing) {
      throw new ConflictError('该政策版本尚未接受');
    }
    if (existing.status === 'withdrawn') {
      return existing;
    }

    const withdrawnAt = new Date();
    try {
      await this.usersRepository.withdrawConsent(existing.id, withdrawnAt);
    } catch {
      throw new DatabaseError();
    }

    return { ...existing, status: 'withdrawn', withdrawnAt };
  }
}
