import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  char,
  date,
  foreignKey,
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
export const knowledgePublicationStatus = pgEnum('knowledge_publication_status', [
  'draft',
  'published',
  'withdrawn',
]);
export const knowledgeReviewStatus = pgEnum('knowledge_review_status', [
  'unverified',
  'source_verified',
  'professional_reviewed',
]);
export const knowledgeContentOrigin = pgEnum('knowledge_content_origin', [
  'curated',
  'synthetic_fixture',
]);

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
    stateRevision: integer('state_revision')
      .notNull()
      .$defaultFn(() => 1),
    effectiveAt: timestamp('effective_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('consents_user_type_version_unique').on(
      table.userId,
      table.consentType,
      table.consentVersion,
    ),
    index('consents_user_status_idx').on(table.userId, table.status),
    uniqueIndex('consents_identity_unique').on(
      table.id,
      table.userId,
      table.consentType,
      table.consentVersion,
    ),
    check('consents_state_revision_positive_check', sql`${table.stateRevision} > 0`),
    check(
      'consents_status_timestamps_check',
      sql`(${table.status} = 'accepted' AND ${table.withdrawnAt} IS NULL) OR (${table.status} = 'withdrawn' AND ${table.withdrawnAt} IS NOT NULL)`,
    ),
  ],
);

export const consentDecisions = pgTable(
  'consent_decisions',
  {
    id: uuid('id').primaryKey(),
    consentId: uuid('consent_id').notNull(),
    userId: uuid('user_id').notNull(),
    consentType: varchar('consent_type', { length: 64 }).notNull(),
    consentVersion: varchar('consent_version', { length: 64 }).notNull(),
    operationId: uuid('operation_id').notNull(),
    decision: varchar('decision', { length: 16 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    priorRevision: integer('prior_revision').notNull(),
    resultingRevision: integer('resulting_revision').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    documentKey: varchar('document_key', { length: 128 }),
    documentRevision: varchar('document_revision', { length: 64 }),
    targetAcceptanceDecisionId: uuid('target_acceptance_decision_id'),
    decisionSource: varchar('decision_source', { length: 32 }).notNull(),
  },
  (table) => [
    uniqueIndex('consent_decisions_user_operation_unique').on(table.userId, table.operationId),
    uniqueIndex('consent_decisions_applied_revision_unique')
      .on(table.consentId, table.resultingRevision)
      .where(sql`${table.outcome} = 'applied'`),
    uniqueIndex('consent_decisions_identity_unique').on(
      table.id,
      table.consentId,
      table.userId,
      table.consentType,
      table.consentVersion,
    ),
    index('consent_decisions_history_idx').on(table.userId, table.occurredAt, table.id),
    foreignKey({
      name: 'consent_decisions_projection_fk',
      columns: [table.consentId, table.userId, table.consentType, table.consentVersion],
      foreignColumns: [consents.id, consents.userId, consents.consentType, consents.consentVersion],
    }).onDelete('cascade'),
    foreignKey({
      name: 'consent_decisions_target_acceptance_fk',
      columns: [
        table.targetAcceptanceDecisionId,
        table.consentId,
        table.userId,
        table.consentType,
        table.consentVersion,
      ],
      foreignColumns: [
        table.id,
        table.consentId,
        table.userId,
        table.consentType,
        table.consentVersion,
      ],
    }).onDelete('cascade'),
    check(
      'consent_decisions_values_check',
      sql`${table.decision} IN ('accepted', 'withdrawn') AND ${table.outcome} IN ('applied', 'no_change') AND ${table.decisionSource} IN ('registration', 'privacy_ui', 'legacy_backfill')`,
    ),
    check(
      'consent_decisions_revision_check',
      sql`${table.priorRevision} >= 0 AND ((${table.outcome} = 'applied' AND ${table.resultingRevision} = ${table.priorRevision} + 1) OR (${table.outcome} = 'no_change' AND ${table.resultingRevision} = ${table.priorRevision}))`,
    ),
    check(
      'consent_decisions_document_pair_check',
      sql`(${table.documentKey} IS NULL) = (${table.documentRevision} IS NULL)`,
    ),
    check(
      'consent_decisions_target_check',
      sql`(${table.decision} = 'accepted' AND ${table.targetAcceptanceDecisionId} IS NULL) OR (${table.decision} = 'withdrawn' AND ${table.targetAcceptanceDecisionId} IS NOT NULL AND ${table.documentKey} IS NULL AND ${table.documentRevision} IS NULL)`,
    ),
    check(
      'consent_decisions_acceptance_evidence_check',
      sql`${table.decision} <> 'accepted' OR ${table.decisionSource} = 'legacy_backfill' OR (${table.documentKey} IS NOT NULL AND ${table.documentRevision} IS NOT NULL)`,
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

export const moodEntries = pgTable(
  'mood_entries',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientRequestId: uuid('client_request_id').notNull(),
    moodScore: integer('mood_score').notNull(),
    emotion: varchar('emotion', { length: 32 }).$type<
      | 'joyful'
      | 'calm'
      | 'hopeful'
      | 'neutral'
      | 'tired'
      | 'stressed'
      | 'sad'
      | 'angry'
      | 'overwhelmed'
    >(),
    note: varchar('note', { length: 500 }),
    stateRevision: integer('state_revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('mood_entries_user_client_request_unique').on(table.userId, table.clientRequestId),
    index('mood_entries_user_created_id_idx').on(table.userId, table.createdAt, table.id),
    check('mood_entries_score_check', sql`${table.moodScore} BETWEEN 1 AND 5`),
    check(
      'mood_entries_emotion_check',
      sql`${table.emotion} IS NULL OR ${table.emotion} IN ('joyful', 'calm', 'hopeful', 'neutral', 'tired', 'stressed', 'sad', 'angry', 'overwhelmed')`,
    ),
    check(
      'mood_entries_note_length_check',
      sql`${table.note} IS NULL OR char_length(${table.note}) <= 500`,
    ),
    check('mood_entries_revision_check', sql`${table.stateRevision} > 0`),
    check('mood_entries_timestamps_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export type KnowledgeContentBlockRecord =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; style: 'ordered' | 'unordered'; items: string[] }
  | { type: 'callout'; tone: 'information' | 'important'; text: string };

export const knowledgeArticles = pgTable(
  'knowledge_articles',
  {
    id: uuid('id').primaryKey(),
    articleKey: varchar('article_key', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_articles_article_key_unique').on(table.articleKey),
    check('knowledge_articles_key_check', sql`${table.articleKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const knowledgeArticleVersions = pgTable(
  'knowledge_article_versions',
  {
    id: uuid('id').primaryKey(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => knowledgeArticles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    summary: varchar('summary', { length: 320 }).notNull(),
    contentBlocks: jsonb('content_blocks').$type<KnowledgeContentBlockRecord[]>().notNull(),
    publicationStatus: knowledgePublicationStatus('publication_status').notNull(),
    reviewStatus: knowledgeReviewStatus('review_status').notNull(),
    contentOrigin: knowledgeContentOrigin('content_origin').notNull(),
    reviewedBy: varchar('reviewed_by', { length: 128 }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_article_versions_article_version_unique').on(
      table.articleId,
      table.version,
    ),
    uniqueIndex('knowledge_article_versions_current_unique')
      .on(table.articleId)
      .where(sql`${table.publicationStatus} = 'published'`),
    index('knowledge_article_versions_current_list_idx').on(
      table.publicationStatus,
      table.publishedAt,
      table.id,
    ),
    check('knowledge_article_versions_version_check', sql`${table.version} > 0`),
    check(
      'knowledge_article_versions_content_blocks_check',
      sql`jsonb_typeof(${table.contentBlocks}) = 'array' AND jsonb_array_length(${table.contentBlocks}) BETWEEN 1 AND 100`,
    ),
    check(
      'knowledge_article_versions_status_timestamps_check',
      sql`(${table.publicationStatus} = 'draft' AND ${table.publishedAt} IS NULL AND ${table.withdrawnAt} IS NULL) OR (${table.publicationStatus} = 'published' AND ${table.publishedAt} IS NOT NULL AND ${table.withdrawnAt} IS NULL) OR (${table.publicationStatus} = 'withdrawn' AND ${table.publishedAt} IS NOT NULL AND ${table.withdrawnAt} IS NOT NULL AND ${table.withdrawnAt} >= ${table.publishedAt})`,
    ),
    check(
      'knowledge_article_versions_review_evidence_check',
      sql`(${table.reviewStatus} = 'unverified' AND ${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL) OR (${table.reviewStatus} IN ('source_verified', 'professional_reviewed') AND ${table.reviewedBy} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`,
    ),
    check(
      'knowledge_article_versions_origin_review_check',
      sql`(${table.contentOrigin} = 'synthetic_fixture' AND ${table.reviewStatus} = 'unverified') OR ${table.contentOrigin} = 'curated'`,
    ),
    check(
      'knowledge_article_versions_curated_publication_check',
      sql`${table.publicationStatus} = 'draft' OR ${table.contentOrigin} = 'synthetic_fixture' OR ${table.reviewStatus} IN ('source_verified', 'professional_reviewed')`,
    ),
  ],
);

export const knowledgeArticleSources = pgTable(
  'knowledge_article_sources',
  {
    id: uuid('id').primaryKey(),
    articleVersionId: uuid('article_version_id')
      .notNull()
      .references(() => knowledgeArticleVersions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    publisherName: varchar('publisher_name', { length: 160 }).notNull(),
    sourceTitle: varchar('source_title', { length: 320 }).notNull(),
    sourceUrl: text('source_url').notNull(),
    sourcePublishedAt: timestamp('source_published_at', { withTimezone: true, mode: 'date' }),
    sourceVersionLabel: varchar('source_version_label', { length: 120 }),
    sourceLocator: varchar('source_locator', { length: 160 }),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('knowledge_article_sources_version_ordinal_unique').on(
      table.articleVersionId,
      table.ordinal,
    ),
    index('knowledge_article_sources_version_idx').on(table.articleVersionId),
    check('knowledge_article_sources_ordinal_check', sql`${table.ordinal} > 0`),
    check('knowledge_article_sources_https_check', sql`${table.sourceUrl} ~ '^https://'`),
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
  consentDecisions,
  conversations,
  dailyUsageQuotas,
  messages,
  moodEntries,
  passwordCredentials,
  quotaConsumptions,
  humanReviewQueueItems,
  knowledgeArticles,
  knowledgeArticleSources,
  knowledgeArticleVersions,
  riskEvents,
  sessions,
  users,
};

export type ConsentStatus = (typeof consentStatus.enumValues)[number];
export type ConsentDecision = 'accepted' | 'withdrawn';
export type ConsentDecisionOutcome = 'applied' | 'no_change';
export type ConsentDecisionSource = 'registration' | 'privacy_ui' | 'legacy_backfill';
export type AiTurnStatus = (typeof aiTurnStatus.enumValues)[number];
export type MessageRole = (typeof messageRole.enumValues)[number];
export type RiskLevel = (typeof riskLevel.enumValues)[number];
export type ReviewState = (typeof reviewState.enumValues)[number];
export type ReviewPriority = (typeof reviewPriority.enumValues)[number];
export type KnowledgePublicationStatus = (typeof knowledgePublicationStatus.enumValues)[number];
export type KnowledgeReviewStatus = (typeof knowledgeReviewStatus.enumValues)[number];
export type KnowledgeContentOrigin = (typeof knowledgeContentOrigin.enumValues)[number];
