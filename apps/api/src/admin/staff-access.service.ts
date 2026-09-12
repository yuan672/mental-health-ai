import { randomUUID } from 'node:crypto';
import type { AppTransaction } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  StaffAuthorizationChangedError,
  isPostgresUniqueViolation,
} from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { PasswordHasherService } from '../auth/password-hasher.service';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import { z } from 'zod';
import type { StaffAuthorizationContext, StaffPermission, StaffRole } from './staff-access.types';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';
import type { CreateStaffPrincipalRequest } from './staff.schemas';
import { StaffRepository, type StaffPrincipalState } from './staff.repository';

const staffCursorSchema = z
  .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() })
  .strict();

export type StaffMutationResult = Readonly<{
  outcome: 'applied' | 'no_change';
  principal: StaffPrincipalState;
  sessionCount?: number;
}>;

@Injectable()
export class StaffAccessService {
  constructor(
    private readonly repository: StaffRepository,
    private readonly authorizer: DatabaseStaffAuthorizer,
    private readonly passwordHasher: PasswordHasherService,
    private readonly audits: AuditLogRepository,
  ) {}

  private async lockAndAuthorize(
    tx: AppTransaction,
    actor: StaffAuthorizationContext,
    targetId: string,
    permission: StaffPermission,
  ): Promise<StaffPrincipalState> {
    for (const id of [...new Set([actor.id, targetId])].sort()) {
      await this.repository.lockPrincipal(tx, id);
    }
    await this.authorizer.authorizeWithinTransaction(tx, actor, permission);
    const target = await this.repository.findPrincipalById(tx, targetId);
    if (!target) throw new NotFoundError();
    return target;
  }

  async create(
    actor: StaffAuthorizationContext,
    input: CreateStaffPrincipalRequest,
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<StaffMutationResult> {
    const passwordHash = await this.passwordHasher.hash(input.initialPassword, signal);
    const attempt = async (): Promise<StaffMutationResult> =>
      this.repository.transaction(async (tx) => {
        await this.repository.lockPrincipal(tx, actor.id);
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'staff_principal:create');
        const byId = await this.repository.findPrincipalById(tx, input.staffPrincipalId);
        const byEmail = await this.repository.findPrincipalByEmail(tx, input.email);
        if (byId || byEmail) {
          if (byId && byId.email === input.email && (!byEmail || byEmail.id === byId.id)) {
            await this.appendDirectoryAudit(tx, actor.id, byId.id, 'id', 1, now);
            return { outcome: 'no_change', principal: byId };
          }
          throw new ConflictError('管理账号标识或邮箱已被使用');
        }
        await this.repository.insertPrincipal(tx, {
          id: input.staffPrincipalId,
          email: input.email,
          passwordHash,
          now,
        });
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'staff_principal_created',
          resourceType: 'staff_principal',
          resourceId: input.staffPrincipalId,
          idempotencyKey: `staff-principal-created:${input.staffPrincipalId}`,
          safeMetadata: {},
          occurredAt: now,
        });
        const principal = await this.repository.findPrincipalById(tx, input.staffPrincipalId);
        if (!principal) throw new Error('Created staff principal was not visible');
        return { outcome: 'applied', principal };
      });
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof ConflictError || error instanceof AuthorizationError) throw error;
      if (isPostgresUniqueViolation(error)) {
        try {
          return await this.repository.transaction(async (tx) => {
            await this.authorizer.authorizeWithinTransaction(tx, actor, 'staff_principal:create');
            const byId = await this.repository.findPrincipalById(tx, input.staffPrincipalId);
            const byEmail = await this.repository.findPrincipalByEmail(tx, input.email);
            if (byId && byId.email === input.email && (!byEmail || byEmail.id === byId.id)) {
              await this.appendDirectoryAudit(tx, actor.id, byId.id, 'id', 1, now);
              return { outcome: 'no_change', principal: byId };
            }
            throw new ConflictError('管理账号标识或邮箱已被使用');
          });
        } catch (reconciled) {
          if (reconciled instanceof ConflictError || reconciled instanceof AuthorizationError)
            throw reconciled;
          throw new DatabaseError();
        }
      }
      throw new DatabaseError();
    }
  }

  async get(
    actor: StaffAuthorizationContext,
    id: string,
    now = new Date(),
  ): Promise<StaffPrincipalState> {
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'staff_principal:read');
        const principal = await this.repository.findPrincipalById(tx, id);
        if (!principal) throw new NotFoundError();
        await this.appendDirectoryAudit(tx, actor.id, id, 'id', 1, now);
        return principal;
      });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof NotFoundError) throw error;
      throw new DatabaseError();
    }
  }

  async list(
    actor: StaffAuthorizationContext,
    limit: number,
    cursorToken: string | undefined,
    now = new Date(),
  ): Promise<{ principals: StaffPrincipalState[]; nextCursor: string | null }> {
    const decoded = decodeOpaqueCursor(cursorToken, staffCursorSchema);
    const cursor = decoded ? { createdAt: new Date(decoded.createdAt), id: decoded.id } : null;
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'staff_principal:read');
        const rows = await this.repository.listPrincipals(tx, limit + 1, cursor);
        const principals = rows.slice(0, limit);
        const last = principals.at(-1);
        const nextCursor =
          rows.length > limit && last
            ? encodeOpaqueCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null;
        await this.appendDirectoryAudit(tx, actor.id, actor.id, 'all', principals.length, now);
        return { principals, nextCursor };
      });
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new DatabaseError();
    }
  }

  async grantRole(
    actor: StaffAuthorizationContext,
    targetId: string,
    roleKey: StaffRole,
    expectedRevision: number,
    now = new Date(),
  ): Promise<StaffMutationResult> {
    return this.changeRole(actor, targetId, roleKey, expectedRevision, 'grant', now);
  }

  async revokeRole(
    actor: StaffAuthorizationContext,
    targetId: string,
    roleKey: StaffRole,
    expectedRevision: number,
    now = new Date(),
  ): Promise<StaffMutationResult> {
    return this.changeRole(actor, targetId, roleKey, expectedRevision, 'revoke', now);
  }

  private async changeRole(
    actor: StaffAuthorizationContext,
    targetId: string,
    roleKey: StaffRole,
    expectedRevision: number,
    action: 'grant' | 'revoke',
    now: Date,
  ): Promise<StaffMutationResult> {
    try {
      return await this.repository.transaction(async (tx) => {
        const target = await this.lockAndAuthorize(
          tx,
          actor,
          targetId,
          action === 'grant' ? 'staff_role:grant' : 'staff_role:revoke',
        );
        const active = await this.repository.findActiveRoleGrant(tx, targetId, roleKey);
        if (target.status !== 'active') throw new ConflictError('已停用的管理账号不能变更角色');
        if ((action === 'grant' && active) || (action === 'revoke' && !active)) {
          await this.appendDirectoryAudit(tx, actor.id, target.id, 'id', 1, now);
          return { outcome: 'no_change', principal: target };
        }
        if (target.authorizationRevision !== expectedRevision) {
          throw new StaffAuthorizationChangedError();
        }
        if (action === 'grant') {
          await this.repository.insertRoleGrant(tx, {
            id: randomUUID(),
            staffPrincipalId: targetId,
            roleKey,
            grantSource: 'staff',
            grantedByPrincipalId: actor.id,
            now,
          });
        } else {
          await this.repository.revokeRoleGrant(tx, targetId, roleKey, actor.id, now);
        }
        const revision = await this.repository.incrementAuthorizationRevision(tx, targetId);
        const sessionCount = await this.repository.revokeAllSessions(tx, targetId, now);
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: action === 'grant' ? 'staff_role_granted' : 'staff_role_revoked',
          resourceType: 'staff_principal',
          resourceId: targetId,
          idempotencyKey: `staff-role-${action}:${targetId}:${roleKey}:${revision}`,
          safeMetadata: { roleKey, resultingAuthorizationRevision: revision },
          occurredAt: now,
        });
        const principal = await this.repository.findPrincipalById(tx, targetId);
        if (!principal) throw new Error('Staff principal disappeared');
        return { outcome: 'applied', principal, sessionCount };
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof StaffAuthorizationChangedError
      )
        throw error;
      throw new DatabaseError();
    }
  }

  async disable(
    actor: StaffAuthorizationContext,
    targetId: string,
    expectedRevision: number,
    now = new Date(),
  ): Promise<StaffMutationResult> {
    try {
      return await this.repository.transaction(async (tx) => {
        const target = await this.lockAndAuthorize(tx, actor, targetId, 'staff_principal:disable');
        if (target.status === 'disabled') {
          await this.appendDirectoryAudit(tx, actor.id, target.id, 'id', 1, now);
          return { outcome: 'no_change', principal: target };
        }
        if (target.authorizationRevision !== expectedRevision)
          throw new StaffAuthorizationChangedError();
        await this.repository.disablePrincipal(tx, targetId, now);
        const revision = await this.repository.incrementAuthorizationRevision(tx, targetId);
        const sessionCount = await this.repository.revokeAllSessions(tx, targetId, now);
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'staff_principal_disabled',
          resourceType: 'staff_principal',
          resourceId: targetId,
          idempotencyKey: `staff-disabled:${targetId}:${revision}`,
          safeMetadata: { resultingAuthorizationRevision: revision },
          occurredAt: now,
        });
        const principal = await this.repository.findPrincipalById(tx, targetId);
        if (!principal) throw new Error('Staff principal disappeared');
        return { outcome: 'applied', principal, sessionCount };
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof StaffAuthorizationChangedError
      )
        throw error;
      throw new DatabaseError();
    }
  }

  async revokeSessions(
    actor: StaffAuthorizationContext,
    targetId: string,
    expectedRevision: number,
    now = new Date(),
  ): Promise<StaffMutationResult> {
    try {
      return await this.repository.transaction(async (tx) => {
        const target = await this.lockAndAuthorize(tx, actor, targetId, 'staff_session:revoke');
        if (target.status !== 'active') throw new ConflictError('已停用的管理账号不能撤销会话');
        if (target.authorizationRevision !== expectedRevision)
          throw new StaffAuthorizationChangedError();
        const revision = await this.repository.incrementAuthorizationRevision(tx, targetId);
        const sessionCount = await this.repository.revokeAllSessions(tx, targetId, now);
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'staff_sessions_revoked',
          resourceType: 'staff_principal',
          resourceId: targetId,
          idempotencyKey: `staff-sessions-revoked:${targetId}:${revision}`,
          safeMetadata: { sessionCount },
          occurredAt: now,
        });
        const principal = await this.repository.findPrincipalById(tx, targetId);
        if (!principal) throw new Error('Staff principal disappeared');
        return { outcome: 'applied', principal, sessionCount };
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof StaffAuthorizationChangedError
      )
        throw error;
      throw new DatabaseError();
    }
  }

  private appendDirectoryAudit(
    tx: AppTransaction,
    actorId: string,
    resourceId: string,
    filterCategory: 'all' | 'id',
    returnedCount: number,
    now: Date,
  ): Promise<unknown> {
    return this.audits.appendWithinTransaction(tx, {
      actorType: 'staff',
      actorId,
      action: 'staff_directory_accessed',
      resourceType: 'staff_principal_query',
      resourceId,
      idempotencyKey: `staff-directory:${randomUUID()}`,
      safeMetadata: { filterCategory, returnedCount },
      occurredAt: now,
    });
  }
}
