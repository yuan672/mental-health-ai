import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  char,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const consentStatus = pgEnum('consent_status', ['accepted', 'withdrawn']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const passwordCredentials = pgTable(
  'password_credentials',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: varchar('password_hash', { length: 512 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('password_credentials_email_unique').on(table.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const ageVerifications = pgTable(
  'age_verifications',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    ageVerified: boolean('age_verified').notNull(),
    verificationMethod: varchar('verification_method', { length: 64 }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [check('age_verifications_verified_check', sql`${table.ageVerified} = true`)],
);

export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentType: varchar('consent_type', { length: 64 }).notNull(),
    consentVersion: varchar('consent_version', { length: 64 }).notNull(),
    status: consentStatus('status').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('consents_user_type_version_unique').on(
      table.userId,
      table.consentType,
      table.consentVersion,
    ),
    index('consents_user_status_idx').on(table.userId, table.status),
    check(
      'consents_status_timestamps_check',
      sql`(${table.status} = 'accepted' AND ${table.withdrawnAt} IS NULL) OR (${table.status} = 'withdrawn' AND ${table.withdrawnAt} IS NOT NULL)`,
    ),
  ],
);

export const schema = {
  ageVerifications,
  consents,
  passwordCredentials,
  sessions,
  users,
};

export type ConsentStatus = (typeof consentStatus.enumValues)[number];
