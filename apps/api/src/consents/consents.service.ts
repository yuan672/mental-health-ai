import { randomUUID } from 'node:crypto';
import type {
  ConsentHistoryItem,
  ConsentHistoryResponse,
  ConsentMutationResponse,
  ConsentType,
} from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ConsentRequiredError,
  DatabaseError,
  ValidationError,
} from '../common/errors';
import { isPostgresUniqueViolation } from '../common/errors/postgres-error';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { UsersRepository, type ConsentRecord } from '../users/users.repository';
import { CONSENT_TYPE_VALUES, ConsentPolicyService } from './consent-policy.service';
import { consentHistoryCursorSchema, type ConsentHistoryQuery } from './consents.schemas';

function toPublicConsent(record: ConsentRecord): ConsentHistoryItem {
  if (!CONSENT_TYPE_VALUES.some((knownType) => knownType === record.consentType)) {
    throw new DatabaseError();
  }

  return {
    consentType: record.consentType as ConsentType,
    consentVersion: record.consentVersion,
    status: record.status,
    acceptedAt: record.acceptedAt.toISOString(),
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
  };
}

@Injectable()
export class ConsentsService {
  constructor(
    private readonly consentPolicy: ConsentPolicyService,
    private readonly usersRepository: UsersRepository,
  ) {}

  async list(userId: string, query: ConsentHistoryQuery): Promise<ConsentHistoryResponse> {
    const decoded = decodeOpaqueCursor(query.cursor, consentHistoryCursorSchema);
    let records: ConsentRecord[];
    try {
      records = await this.usersRepository.listConsentHistoryPage(
        userId,
        CONSENT_TYPE_VALUES,
        query.limit + 1,
        decoded ? { acceptedAt: new Date(decoded.acceptedAt), id: decoded.id } : null,
      );
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError();
    }

    const hasNextPage = records.length > query.limit;
    const page = records.slice(0, query.limit);
    const last = page.at(-1);

    return {
      success: true,
      data: {
        consents: page.map(toPublicConsent),
        nextCursor:
          hasNextPage && last
            ? encodeOpaqueCursor({
                kind: 'consent-history',
                version: 1,
                acceptedAt: last.acceptedAt.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
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
  ): Promise<ConsentMutationResponse> {
    if (!this.consentPolicy.isKnownConsentType(consentType)) {
      throw new ValidationError('授权类型无效');
    }
    if (!this.consentPolicy.isCurrentRequiredPolicy(consentType, consentVersion)) {
      throw new ConflictError('只能接受当前政策版本');
    }

    const existing = await this.usersRepository.findConsent(userId, consentType, consentVersion);
    if (existing?.status === 'accepted') {
      return { success: true, data: { consent: toPublicConsent(existing) } };
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
      return { success: true, data: { consent: toPublicConsent(consent) } };
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
  ): Promise<ConsentMutationResponse> {
    if (!this.consentPolicy.isKnownConsentType(consentType)) {
      throw new ValidationError('授权类型无效');
    }
    const existing = await this.usersRepository.findConsent(userId, consentType, consentVersion);
    if (!existing) {
      throw new ConflictError('该政策版本尚未接受');
    }
    if (existing.status === 'withdrawn') {
      return { success: true, data: { consent: toPublicConsent(existing) } };
    }

    const withdrawnAt = new Date();
    try {
      await this.usersRepository.withdrawConsent(existing.id, withdrawnAt);
    } catch {
      throw new DatabaseError();
    }

    return {
      success: true,
      data: {
        consent: toPublicConsent({ ...existing, status: 'withdrawn', withdrawnAt }),
      },
    };
  }
}
