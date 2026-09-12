import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  staffPasswordCredentials,
  staffPrincipals,
  staffRoleGrants,
  staffSessions,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { staffRoleSchema, type StaffRole } from './staff-access.types';

export type StaffPrincipalRecord = typeof staffPrincipals.$inferSelect;
export type StaffCredentialRecord = typeof staffPasswordCredentials.$inferSelect;
export type StaffSessionRecord = typeof staffSessions.$inferSelect;
export type StaffPrincipalState = StaffPrincipalRecord & {
  email: string;
  roleKeys: StaffRole[];
};

export type StaffListCursor = Readonly<{ createdAt: Date; id: string }>;

@Injectable()
export class StaffRepository {
  constructor(private readonly database: DatabaseService) {}

  transaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work);
  }

  async acquireBootstrapLock(tx: AppTransaction): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(771420020)`);
  }

  async hasBootstrapGrant(tx: AppTransaction): Promise<boolean> {
    const [row] = await tx
      .select({ id: staffRoleGrants.id })
      .from(staffRoleGrants)
      .where(eq(staffRoleGrants.grantSource, 'bootstrap'))
      .limit(1);
    return Boolean(row);
  }

  insertPrincipal(
    tx: AppTransaction,
    input: { id: string; email: string; passwordHash: string; now: Date },
  ): Promise<unknown> {
    return tx
      .insert(staffPrincipals)
      .values({ id: input.id, createdAt: input.now })
      .then(() =>
        tx.insert(staffPasswordCredentials).values({
          staffPrincipalId: input.id,
          email: input.email,
          passwordHash: input.passwordHash,
          createdAt: input.now,
          updatedAt: input.now,
        }),
      );
  }

  insertRoleGrant(
    tx: AppTransaction,
    input: {
      id: string;
      staffPrincipalId: string;
      roleKey: StaffRole;
      grantSource: 'bootstrap' | 'staff';
      grantedByPrincipalId: string | null;
      now: Date;
    },
  ): Promise<unknown> {
    return tx.insert(staffRoleGrants).values({
      ...input,
      grantedAt: input.now,
    });
  }

  async findCredentialByEmail(email: string): Promise<StaffCredentialRecord | null> {
    const [row] = await this.database.database
      .select()
      .from(staffPasswordCredentials)
      .where(eq(staffPasswordCredentials.email, email))
      .limit(1);
    return row ?? null;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StaffSessionRecord | null> {
    const [row] = await this.database.database
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  async findSessionById(
    tx: AppTransaction,
    sessionId: string,
    principalId: string,
  ): Promise<StaffSessionRecord | null> {
    const [row] = await tx
      .select()
      .from(staffSessions)
      .where(and(eq(staffSessions.id, sessionId), eq(staffSessions.staffPrincipalId, principalId)))
      .limit(1);
    return row ?? null;
  }

  async revokeSession(sessionId: string, principalId: string, now: Date): Promise<void> {
    await this.database.database
      .update(staffSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(staffSessions.id, sessionId),
          eq(staffSessions.staffPrincipalId, principalId),
          isNull(staffSessions.revokedAt),
        ),
      );
  }

  async revokeAllSessions(tx: AppTransaction, principalId: string, now: Date): Promise<number> {
    const rows = await tx
      .update(staffSessions)
      .set({ revokedAt: now })
      .where(and(eq(staffSessions.staffPrincipalId, principalId), isNull(staffSessions.revokedAt)))
      .returning({ id: staffSessions.id });
    return rows.length;
  }

  async incrementAuthorizationRevision(tx: AppTransaction, principalId: string): Promise<number> {
    const [row] = await tx
      .update(staffPrincipals)
      .set({ authorizationRevision: sql`${staffPrincipals.authorizationRevision} + 1` })
      .where(eq(staffPrincipals.id, principalId))
      .returning({ authorizationRevision: staffPrincipals.authorizationRevision });
    if (!row) throw new Error('Staff principal disappeared while advancing revision');
    return row.authorizationRevision;
  }

  async findActiveRoleGrant(
    tx: AppTransaction,
    principalId: string,
    roleKey: StaffRole,
  ): Promise<{ id: string } | null> {
    const [row] = await tx
      .select({ id: staffRoleGrants.id })
      .from(staffRoleGrants)
      .where(
        and(
          eq(staffRoleGrants.staffPrincipalId, principalId),
          eq(staffRoleGrants.roleKey, roleKey),
          isNull(staffRoleGrants.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async revokeRoleGrant(
    tx: AppTransaction,
    principalId: string,
    roleKey: StaffRole,
    revokedByPrincipalId: string,
    now: Date,
  ): Promise<void> {
    await tx
      .update(staffRoleGrants)
      .set({ revokedByPrincipalId, revokedAt: now })
      .where(
        and(
          eq(staffRoleGrants.staffPrincipalId, principalId),
          eq(staffRoleGrants.roleKey, roleKey),
          isNull(staffRoleGrants.revokedAt),
        ),
      );
  }

  async lockPrincipal(
    tx: AppTransaction,
    principalId: string,
  ): Promise<StaffPrincipalRecord | null> {
    const [row] = await tx
      .select()
      .from(staffPrincipals)
      .where(eq(staffPrincipals.id, principalId))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  async findPrincipalById(
    tx: AppTransaction,
    principalId: string,
  ): Promise<StaffPrincipalState | null> {
    const [base] = await tx
      .select({ principal: staffPrincipals, email: staffPasswordCredentials.email })
      .from(staffPrincipals)
      .innerJoin(
        staffPasswordCredentials,
        eq(staffPasswordCredentials.staffPrincipalId, staffPrincipals.id),
      )
      .where(eq(staffPrincipals.id, principalId))
      .limit(1);
    if (!base) return null;
    return {
      ...base.principal,
      email: base.email,
      roleKeys: await this.listActiveRoles(tx, principalId),
    };
  }

  async findPrincipalByEmail(
    tx: AppTransaction,
    email: string,
  ): Promise<StaffPrincipalState | null> {
    const [row] = await tx
      .select({ id: staffPasswordCredentials.staffPrincipalId })
      .from(staffPasswordCredentials)
      .where(eq(staffPasswordCredentials.email, email))
      .limit(1);
    return row ? this.findPrincipalById(tx, row.id) : null;
  }

  async listActiveRoles(tx: AppTransaction, principalId: string): Promise<StaffRole[]> {
    const rows = await tx
      .select({ roleKey: staffRoleGrants.roleKey })
      .from(staffRoleGrants)
      .where(
        and(eq(staffRoleGrants.staffPrincipalId, principalId), isNull(staffRoleGrants.revokedAt)),
      )
      .orderBy(asc(staffRoleGrants.roleKey));
    return rows.map((row) => staffRoleSchema.parse(row.roleKey));
  }

  async listPrincipals(
    tx: AppTransaction,
    limit: number,
    cursor: StaffListCursor | null,
  ): Promise<StaffPrincipalState[]> {
    const cursorFilter = cursor
      ? or(
          lt(staffPrincipals.createdAt, cursor.createdAt),
          and(eq(staffPrincipals.createdAt, cursor.createdAt), lt(staffPrincipals.id, cursor.id)),
        )
      : undefined;
    const rows = await tx
      .select({ principal: staffPrincipals, email: staffPasswordCredentials.email })
      .from(staffPrincipals)
      .innerJoin(
        staffPasswordCredentials,
        eq(staffPasswordCredentials.staffPrincipalId, staffPrincipals.id),
      )
      .where(cursorFilter)
      .orderBy(desc(staffPrincipals.createdAt), desc(staffPrincipals.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const grants = await tx
      .select({ principalId: staffRoleGrants.staffPrincipalId, roleKey: staffRoleGrants.roleKey })
      .from(staffRoleGrants)
      .where(
        and(
          inArray(
            staffRoleGrants.staffPrincipalId,
            rows.map((row) => row.principal.id),
          ),
          isNull(staffRoleGrants.revokedAt),
        ),
      );
    return rows.map((row) => ({
      ...row.principal,
      email: row.email,
      roleKeys: grants
        .filter((grant) => grant.principalId === row.principal.id)
        .map((grant) => staffRoleSchema.parse(grant.roleKey))
        .sort(),
    }));
  }

  async createSession(
    tx: AppTransaction,
    input: {
      id: string;
      staffPrincipalId: string;
      tokenHash: string;
      authorizationRevision: number;
      expiresAt: Date;
      now: Date;
    },
  ): Promise<void> {
    await tx.insert(staffSessions).values({
      id: input.id,
      staffPrincipalId: input.staffPrincipalId,
      tokenHash: input.tokenHash,
      issuedAuthorizationRevision: input.authorizationRevision,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    });
  }

  async disablePrincipal(tx: AppTransaction, principalId: string, now: Date): Promise<void> {
    await tx
      .update(staffPrincipals)
      .set({ status: 'disabled', disabledAt: now })
      .where(eq(staffPrincipals.id, principalId));
  }
}
