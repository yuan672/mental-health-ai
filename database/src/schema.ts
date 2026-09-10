import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  char,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const consentStatus = pgEnum('consent_status', ['accepted', 'withdrawn']);
export const messageRole = pgEnum('message_role', ['user', 'assistant']);
export const aiTurnStatus = pgEnum('ai_turn_status', [
  'claimed',
  'streaming',
  'completed',
  'failed',
  'cancelled',
]);
export const riskLevel = pgEnum('risk_level', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const reviewState = pgEnum('review_state', ['pending', 'in_review', 'resolved']);
export const reviewPriority = pgEnum('review_priority', ['high', 'urgent']);

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

export const dailyUsageQuotas = pgTable(
  'daily_usage_quotas',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    usageDate: date('usage_date', { mode: 'string' }).notNull(),
    dailyLimit: integer('daily_limit').notNull(),
    usedCount: integer('used_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'daily_usage_quotas_user_date_pk',
      columns: [table.userId, table.usageDate],
    }),
    check('daily_usage_quotas_limit_check', sql`${table.dailyLimit} > 0`),
    check(
      'daily_usage_quotas_used_count_check',
      sql`${table.usedCount} >= 0 AND ${table.usedCount} <= ${table.dailyLimit}`,
    ),
  ],
);

export const quotaConsumptions = pgTable(
  'quota_consumptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    usageDate: date('usage_date', { mode: 'string' }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('quota_consumptions_user_key_unique').on(table.userId, table.idempotencyKey),
    index('quota_consumptions_user_date_idx').on(table.userId, table.usageDate),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    isSaved: boolean('is_saved').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('conversations_user_created_id_idx').on(table.userId, table.createdAt, table.id),
    index('conversations_expires_at_idx').on(table.expiresAt),
    check(
      'conversations_saved_expiry_check',
      sql`(${table.isSaved} = true AND ${table.expiresAt} IS NULL) OR (${table.isSaved} = false AND ${table.expiresAt} IS NOT NULL)`,
    ),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRole('role').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('messages_conversation_sequence_unique').on(
      table.conversationId,
      table.sequenceNumber,
    ),
    check('messages_sequence_positive_check', sql`${table.sequenceNumber} > 0`),
  ],
);

export const aiTurns = pgTable(
  'ai_turns',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    clientRequestId: uuid('client_request_id').notNull(),
    status: aiTurnStatus('status').notNull(),
    promptKey: varchar('prompt_key', { length: 64 }).notNull(),
    promptVersion: varchar('prompt_version', { length: 64 }).notNull(),
    userMessageId: uuid('user_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    assistantMessageId: uuid('assistant_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    failureCode: varchar('failure_code', { length: 64 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('ai_turns_user_client_request_unique').on(table.userId, table.clientRequestId),
    uniqueIndex('ai_turns_user_message_unique').on(table.userMessageId),
    uniqueIndex('ai_turns_assistant_message_unique').on(table.assistantMessageId),
    uniqueIndex('ai_turns_conversation_active_unique')
      .on(table.conversationId)
      .where(sql`${table.status} IN ('claimed', 'streaming')`),
    index('ai_turns_user_status_idx').on(table.userId, table.status),
    index('ai_turns_conversation_idx').on(table.conversationId),
    index('ai_turns_lease_expires_at_idx').on(table.leaseExpiresAt),
  ],
);

export const riskEvents = pgTable(
  'risk_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    aiTurnId: uuid('ai_turn_id').references(() => aiTurns.id, { onDelete: 'set null' }),
    triggerMessageId: uuid('trigger_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    clientRequestId: uuid('client_request_id').notNull(),
    isIncognito: boolean('is_incognito').notNull(),
    level: riskLevel('risk_level').notNull(),
    riskCategories: text('risk_categories').array().notNull(),
    reasonCodes: text('reason_codes').array().notNull(),
    detectionSource: varchar('detection_source', { length: 32 }).notNull(),
    policyVersion: varchar('policy_version', { length: 64 }).notNull(),
    classifierKey: varchar('classifier_key', { length: 64 }),
    classifierVersion: varchar('classifier_version', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('risk_events_ai_turn_unique')
      .on(table.aiTurnId)
      .where(sql`${table.aiTurnId} IS NOT NULL`),
    uniqueIndex('risk_events_incognito_request_unique')
      .on(table.userId, table.clientRequestId)
      .where(sql`${table.isIncognito} = true AND ${table.userId} IS NOT NULL`),
    index('risk_events_user_created_idx').on(table.userId, table.createdAt),
    index('risk_events_retention_until_idx').on(table.retentionUntil),
    check(
      'risk_events_incognito_refs_check',
      sql`${table.isIncognito} = false OR (${table.conversationId} IS NULL AND ${table.aiTurnId} IS NULL AND ${table.triggerMessageId} IS NULL)`,
    ),
  ],
);

export const humanReviewQueueItems = pgTable(
  'human_review_queue_items',
  {
    id: uuid('id').primaryKey(),
    riskEventId: uuid('risk_event_id')
      .notNull()
      .references(() => riskEvents.id, { onDelete: 'cascade' }),
    priority: reviewPriority('priority').notNull(),
    state: reviewState('state').notNull().default('pending'),
    assignedReviewerId: varchar('assigned_reviewer_id', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    resolutionCode: varchar('resolution_code', { length: 64 }),
  },
  (table) => [
    uniqueIndex('human_review_queue_risk_event_unique').on(table.riskEventId),
    index('human_review_queue_state_priority_idx').on(table.state, table.priority, table.createdAt),
    check(
      'human_review_queue_state_timestamps_check',
      sql`(${table.state} = 'pending' AND ${table.startedAt} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.resolutionCode} IS NULL) OR (${table.state} = 'in_review' AND ${table.startedAt} IS NOT NULL AND ${table.reviewedAt} IS NULL AND ${table.resolutionCode} IS NULL) OR (${table.state} = 'resolved' AND ${table.startedAt} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.resolutionCode} IS NOT NULL)`,
    ),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    actorType: varchar('actor_type', { length: 32 }).notNull(),
    actorId: varchar('actor_id', { length: 128 }),
    action: varchar('action', { length: 64 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 192 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    safeMetadata: jsonb('safe_metadata')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('audit_logs_idempotency_key_unique').on(table.idempotencyKey),
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId, table.occurredAt),
    index('audit_logs_retention_until_idx').on(table.retentionUntil),
  ],
);

export const schema = {
  ageVerifications,
  aiTurns,
  auditLogs,
  consents,
  conversations,
  dailyUsageQuotas,
  messages,
  passwordCredentials,
  quotaConsumptions,
  humanReviewQueueItems,
  riskEvents,
  sessions,
  users,
};

export type ConsentStatus = (typeof consentStatus.enumValues)[number];
export type AiTurnStatus = (typeof aiTurnStatus.enumValues)[number];
export type MessageRole = (typeof messageRole.enumValues)[number];
export type RiskLevel = (typeof riskLevel.enumValues)[number];
export type ReviewState = (typeof reviewState.enumValues)[number];
export type ReviewPriority = (typeof reviewPriority.enumValues)[number];
