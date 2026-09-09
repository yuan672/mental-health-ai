import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConflictError, DatabaseError } from '../common/errors';
import { isPostgresUniqueViolation } from '../common/errors/postgres-error';
import { UsersRepository, type ConsentRecord } from '../users/users.repository';

@Injectable()
export class ConsentsService {
  constructor(private readonly usersRepository: UsersRepository) {}

  list(userId: string): Promise<ConsentRecord[]> {
    return this.usersRepository.listConsents(userId);
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
