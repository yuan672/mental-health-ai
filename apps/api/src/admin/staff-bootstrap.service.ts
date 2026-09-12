import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConflictError, DatabaseError } from '../common/errors';
import { env } from '../config/env';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import { PasswordHasherService } from '../auth/password-hasher.service';
import { StaffRepository, type StaffPrincipalState } from './staff.repository';

@Injectable()
export class StaffBootstrapService {
  constructor(
    private readonly repository: StaffRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly audits: AuditLogRepository,
  ) {}

  async bootstrap(
    input: { staffPrincipalId: string; email: string; password: string },
    now = new Date(),
  ): Promise<StaffPrincipalState> {
    if (env.APP_ENV !== 'development' && env.APP_ENV !== 'test') {
      throw new ConflictError('当前环境未配置管理账号初始化前置条件');
    }
    const passwordHash = await this.passwordHasher.hash(input.password);
    try {
      return await this.repository.transaction(async (tx) => {
        await this.repository.acquireBootstrapLock(tx);
        if (await this.repository.hasBootstrapGrant(tx)) {
          throw new ConflictError('管理账号初始化已完成');
        }
        await this.repository.insertPrincipal(tx, {
          id: input.staffPrincipalId,
          email: input.email,
          passwordHash,
          now,
        });
        await this.repository.insertRoleGrant(tx, {
          id: randomUUID(),
          staffPrincipalId: input.staffPrincipalId,
          roleKey: 'access_administrator',
          grantSource: 'bootstrap',
          grantedByPrincipalId: null,
          now,
        });
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'system',
          actorId: null,
          action: 'staff_principal_bootstrapped',
          resourceType: 'staff_principal',
          resourceId: input.staffPrincipalId,
          idempotencyKey: `staff-principal-bootstrapped:${input.staffPrincipalId}`,
          safeMetadata: { roleKey: 'access_administrator' },
          occurredAt: now,
        });
        const principal = await this.repository.findPrincipalById(tx, input.staffPrincipalId);
        if (!principal) throw new Error('Bootstrap principal was not visible');
        return principal;
      });
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      throw new DatabaseError();
    }
  }
}
