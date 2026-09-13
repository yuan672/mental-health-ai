import { createHash } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import type { Pool, PoolClient } from '@mental-health/database';
import type { Nf04FixtureSecrets } from './nf04-contract';
import { readNf04DatabaseIdentity, assertNf04DatabaseIdentity } from './nf04-guards';

export const NF04_FIXTURE_IDS = {
  user: '6f040000-0000-4000-8000-000000000001',
  session: '6f040000-0000-4000-8000-000000000002',
  ageVerification: '6f040000-0000-4000-8000-000000000003',
  termsConsent: '6f040000-0000-4000-8000-000000000004',
  privacyConsent: '6f040000-0000-4000-8000-000000000005',
  termsDecision: '6f040000-0000-4000-8000-000000000006',
  privacyDecision: '6f040000-0000-4000-8000-000000000007',
  termsOperation: '6f040000-0000-4000-8000-000000000008',
  privacyOperation: '6f040000-0000-4000-8000-000000000009',
  conversation: '6f040000-0000-4000-8000-000000000010',
  userMessage: '6f040000-0000-4000-8000-000000000011',
  assistantMessage: '6f040000-0000-4000-8000-000000000012',
  aiTurn: '6f040000-0000-4000-8000-000000000013',
  aiClientRequest: '6f040000-0000-4000-8000-000000000014',
  moodEntry: '6f040000-0000-4000-8000-000000000015',
  moodClientRequest: '6f040000-0000-4000-8000-000000000016',
  quotaConsumption: '6f040000-0000-4000-8000-000000000017',
  riskEvent: '6f040000-0000-4000-8000-000000000018',
  reviewQueueItem: '6f040000-0000-4000-8000-000000000019',
  riskAudit: '6f040000-0000-4000-8000-000000000020',
  accountDeletionOperation: '6f040000-0000-4000-8000-000000000021',
  staffPrincipal: '6f040000-0000-4000-8000-000000000022',
  staffRoleGrant: '6f040000-0000-4000-8000-000000000023',
  staffAudit: '6f040000-0000-4000-8000-000000000024',
  knowledgeArticle: '6f040000-0000-4000-8000-000000000025',
  knowledgeVersion: '6f040000-0000-4000-8000-000000000026',
  knowledgeSource: '6f040000-0000-4000-8000-000000000027',
} as const;

export const NF04_FIXTURE_VALUES = {
  knowledgeArticleKey: 'nf04-synthetic-neutral-content',
  quotaIdempotencyKey: 'nf04-synthetic-quota-consumption',
  conversationUserText: '这是仅用于数据库关系验证的合成中性消息。',
  conversationAssistantText: '这是对应的合成中性回复，不包含真实用户内容。',
} as const;

export type Nf04FixtureLoadResult = Readonly<{
  status: 'created' | 'existing';
  userId: string;
  sessionId: string;
  accountDeletionOperationId: string;
}>;

export type Nf04FixtureHooks = Readonly<{
  afterGlobalRecords?: () => void | Promise<void>;
  afterUserRecords?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
}>;

export class Nf04FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04FixtureError.name;
  }
}

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function loadNf04Fixture(input: {
  pool: Pool;
  secrets: Nf04FixtureSecrets;
  appEnvironment: string | undefined;
  expectedDatabaseName: string;
  expectedDatabaseOid: number;
  expectedSystemIdentifier: string;
  expectedDatabaseRole: string;
  expectedMigrationHashes: readonly string[];
  hooks?: Nf04FixtureHooks;
}): Promise<Nf04FixtureLoadResult> {
  if (input.appEnvironment !== 'test') {
    throw new Nf04FixtureError('NF-04 fixture loading requires APP_ENV=test');
  }
  const identity = await readNf04DatabaseIdentity(input.pool);
  assertNf04DatabaseIdentity(identity, {
    databaseName: input.expectedDatabaseName,
    databaseOid: input.expectedDatabaseOid,
    systemIdentifier: input.expectedSystemIdentifier,
    roleName: input.expectedDatabaseRole,
  });
  if (identity.currentUser !== input.expectedDatabaseRole) {
    throw new Nf04FixtureError('NF-04 fixture database role does not match the manifest');
  }
  const migrations = await input.pool.query<{ hash: string }>(
    'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id',
  );
  if (
    migrations.rows.length !== input.expectedMigrationHashes.length ||
    migrations.rows.some((row, index) => row.hash !== input.expectedMigrationHashes[index])
  ) {
    throw new Nf04FixtureError('NF-04 fixture requires the exact migration head');
  }

  const userPasswordHash = await hash(input.secrets.userPassword, ARGON2_OPTIONS);
  const staffPasswordHash = await hash(input.secrets.staffPassword, ARGON2_OPTIONS);
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('lock_timeout','5s',true)");
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x6f04]);
    const footprint = await readFixtureFootprint(client);
    if (footprint > 0) {
      await verifyNf04Fixture(client, input.secrets);
      await client.query('COMMIT');
      return fixtureResult('existing');
    }

    await insertGlobalRecords(client, input.secrets, staffPasswordHash);
    await input.hooks?.afterGlobalRecords?.();
    await insertUserRecords(client, input.secrets, userPasswordHash);
    await input.hooks?.afterUserRecords?.();
    await verifyNf04Fixture(client, input.secrets);
    await input.hooks?.beforeCommit?.();
    await client.query('COMMIT');
    return fixtureResult('created');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Nf04FixtureError) throw error;
    throw new Nf04FixtureError('NF-04 fixture transaction failed');
  } finally {
    client.release();
  }
}

export async function validateNf04Fixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await verifyNf04Fixture(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof Nf04FixtureError) throw error;
    throw new Nf04FixtureError('NF-04 fixture validation failed');
  } finally {
    client.release();
  }
}

async function readFixtureFootprint(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT sum(found)::int AS count FROM (
       SELECT count(*)::int AS found FROM users
       UNION ALL SELECT count(*)::int FROM staff_principals
       UNION ALL SELECT count(*)::int FROM knowledge_articles
       UNION ALL SELECT count(*)::int FROM audit_logs
     ) footprint`,
  );
  return result.rows[0]?.count ?? 0;
}

async function insertGlobalRecords(
  client: PoolClient,
  secrets: Nf04FixtureSecrets,
  staffPasswordHash: string,
): Promise<void> {
  const at = '2026-09-13T02:00:00.000Z';
  await client.query(
    `INSERT INTO staff_principals
       (id,status,authorization_revision,created_at,disabled_at)
     VALUES ($1,'active',1,$2,NULL)`,
    [NF04_FIXTURE_IDS.staffPrincipal, at],
  );
  await client.query(
    `INSERT INTO staff_password_credentials
       (staff_principal_id,email,password_hash,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4)`,
    [NF04_FIXTURE_IDS.staffPrincipal, secrets.staffEmail, staffPasswordHash, at],
  );
  await client.query(
    `INSERT INTO staff_role_grants
       (id,staff_principal_id,role_key,grant_source,granted_by_principal_id,granted_at,
        revoked_by_principal_id,revoked_at)
     VALUES ($1,$2,'access_administrator','bootstrap',NULL,$3,NULL,NULL)`,
    [NF04_FIXTURE_IDS.staffRoleGrant, NF04_FIXTURE_IDS.staffPrincipal, at],
  );
  await client.query(
    `INSERT INTO knowledge_articles (id,article_key,created_at) VALUES ($1,$2,$3)`,
    [NF04_FIXTURE_IDS.knowledgeArticle, NF04_FIXTURE_VALUES.knowledgeArticleKey, at],
  );
  await client.query(
    `INSERT INTO knowledge_article_versions
       (id,article_id,version,title,summary,content_blocks,draft_revision,
        publication_status,review_status,content_origin,reviewed_by,reviewed_at,
        published_at,withdrawn_at,created_at)
     VALUES ($1,$2,1,'NF-04 合成中性知识','仅用于数据库关系验证',
       $3::jsonb,1,'draft','unverified','synthetic_fixture',NULL,NULL,NULL,NULL,$4)`,
    [
      NF04_FIXTURE_IDS.knowledgeVersion,
      NF04_FIXTURE_IDS.knowledgeArticle,
      JSON.stringify([{ type: 'paragraph', text: '这是合成测试内容，不是正式知识文章。' }]),
      at,
    ],
  );
  await client.query(
    `INSERT INTO knowledge_article_sources
       (id,article_version_id,ordinal,publisher_name,source_title,source_url,
        source_published_at,source_version_label,source_locator,retrieved_at)
     VALUES ($1,$2,1,'NF-04 Synthetic Publisher','Synthetic Source',
       'https://fixture.invalid/nf04-source',NULL,'fixture-v1','synthetic locator',$3)`,
    [NF04_FIXTURE_IDS.knowledgeSource, NF04_FIXTURE_IDS.knowledgeVersion, at],
  );
  await client.query(
    `UPDATE knowledge_article_versions
     SET publication_status='published',published_at=$1
     WHERE id=$2`,
    [at, NF04_FIXTURE_IDS.knowledgeVersion],
  );
  await client.query(
    `INSERT INTO audit_logs
       (id,actor_type,actor_id,action,resource_type,resource_id,idempotency_key,
        occurred_at,safe_metadata,retention_until)
     VALUES ($1,'system',NULL,'staff_principal_bootstrapped','staff_principal',$2,$3,
       $4,$5::jsonb,$6)`,
    [
      NF04_FIXTURE_IDS.staffAudit,
      NF04_FIXTURE_IDS.staffPrincipal,
      'nf04:staff-principal-bootstrapped',
      at,
      JSON.stringify({ roleKey: 'access_administrator' }),
      '2026-12-12T02:00:00.000Z',
    ],
  );
}

async function insertUserRecords(
  client: PoolClient,
  secrets: Nf04FixtureSecrets,
  userPasswordHash: string,
): Promise<void> {
  const at = '2026-09-13T02:00:00.000Z';
  await client.query('INSERT INTO users (id,created_at) VALUES ($1,$2)', [
    NF04_FIXTURE_IDS.user,
    at,
  ]);
  await client.query(
    `INSERT INTO password_credentials (user_id,email,password_hash,created_at)
     VALUES ($1,$2,$3,$4)`,
    [NF04_FIXTURE_IDS.user, secrets.userEmail, userPasswordHash, at],
  );
  await client.query(
    `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,revoked_at)
     VALUES ($1,$2,$3,$4,$5,NULL)`,
    [
      NF04_FIXTURE_IDS.session,
      NF04_FIXTURE_IDS.user,
      hashToken(secrets.sessionToken),
      at,
      '2099-01-01T00:00:00.000Z',
    ],
  );
  await client.query(
    `INSERT INTO age_verifications (user_id,age_verified,verification_method,verified_at)
     VALUES ($1,true,'nf04_synthetic_fixture',$2)`,
    [NF04_FIXTURE_IDS.user, at],
  );
  await insertConsent(client, {
    consentId: NF04_FIXTURE_IDS.termsConsent,
    decisionId: NF04_FIXTURE_IDS.termsDecision,
    operationId: NF04_FIXTURE_IDS.termsOperation,
    consentType: 'terms_of_service',
    documentKey: 'synthetic.terms-of-service',
  });
  await insertConsent(client, {
    consentId: NF04_FIXTURE_IDS.privacyConsent,
    decisionId: NF04_FIXTURE_IDS.privacyDecision,
    operationId: NF04_FIXTURE_IDS.privacyOperation,
    consentType: 'privacy_policy',
    documentKey: 'synthetic.privacy-policy',
  });
  await client.query(
    `INSERT INTO conversations (id,user_id,created_at,expires_at,is_saved,deleted_at)
     VALUES ($1,$2,$3,$4,false,NULL)`,
    [NF04_FIXTURE_IDS.conversation, NF04_FIXTURE_IDS.user, at, '2026-12-12T02:00:00.000Z'],
  );
  await client.query(
    `INSERT INTO messages (id,conversation_id,role,sequence_number,content,created_at)
     VALUES ($1,$2,'user',1,$3,$5),($4,$2,'assistant',2,$6,$5)`,
    [
      NF04_FIXTURE_IDS.userMessage,
      NF04_FIXTURE_IDS.conversation,
      NF04_FIXTURE_VALUES.conversationUserText,
      NF04_FIXTURE_IDS.assistantMessage,
      at,
      NF04_FIXTURE_VALUES.conversationAssistantText,
    ],
  );
  await client.query(
    `INSERT INTO assistant_message_knowledge_references
       (assistant_message_id,article_version_id,ordinal) VALUES ($1,$2,1)`,
    [NF04_FIXTURE_IDS.assistantMessage, NF04_FIXTURE_IDS.knowledgeVersion],
  );
  await client.query(
    `INSERT INTO ai_turns
       (id,user_id,conversation_id,client_request_id,status,prompt_key,prompt_version,
        user_message_id,assistant_message_id,failure_code,lease_expires_at,created_at,
        started_at,completed_at)
     VALUES ($1,$2,$3,$4,'completed','supportive-chat','nf04-synthetic-v1',$5,$6,NULL,
       $7,$7,$7,$7)`,
    [
      NF04_FIXTURE_IDS.aiTurn,
      NF04_FIXTURE_IDS.user,
      NF04_FIXTURE_IDS.conversation,
      NF04_FIXTURE_IDS.aiClientRequest,
      NF04_FIXTURE_IDS.userMessage,
      NF04_FIXTURE_IDS.assistantMessage,
      at,
    ],
  );
  await client.query(
    `INSERT INTO mood_entries
       (id,user_id,client_request_id,mood_score,emotion,note,state_revision,created_at,updated_at)
     VALUES ($1,$2,$3,3,'neutral','合成中性心情记录',1,$4,$4)`,
    [NF04_FIXTURE_IDS.moodEntry, NF04_FIXTURE_IDS.user, NF04_FIXTURE_IDS.moodClientRequest, at],
  );
  await client.query(
    `INSERT INTO daily_usage_quotas
       (user_id,usage_date,daily_limit,used_count,created_at,updated_at)
     VALUES ($1,'2026-09-13',20,1,$2,$2)`,
    [NF04_FIXTURE_IDS.user, at],
  );
  await client.query(
    `INSERT INTO quota_consumptions (id,user_id,usage_date,idempotency_key,created_at)
     VALUES ($1,$2,'2026-09-13',$3,$4)`,
    [
      NF04_FIXTURE_IDS.quotaConsumption,
      NF04_FIXTURE_IDS.user,
      NF04_FIXTURE_VALUES.quotaIdempotencyKey,
      at,
    ],
  );
  await client.query(
    `INSERT INTO risk_events
       (id,user_id,conversation_id,ai_turn_id,trigger_message_id,client_request_id,
        is_incognito,risk_level,risk_categories,reason_codes,detection_source,
        policy_version,classifier_key,classifier_version,created_at,retention_until)
     VALUES ($1,$2,$3,$4,$5,$6,false,'HIGH',ARRAY['synthetic_fixture'],
       ARRAY['SYNTHETIC_NON_CLINICAL_FIXTURE'],'deterministic','nf04-fixture-v1',
       NULL,NULL,$7,$8)`,
    [
      NF04_FIXTURE_IDS.riskEvent,
      NF04_FIXTURE_IDS.user,
      NF04_FIXTURE_IDS.conversation,
      NF04_FIXTURE_IDS.aiTurn,
      NF04_FIXTURE_IDS.userMessage,
      NF04_FIXTURE_IDS.aiClientRequest,
      at,
      '2027-03-12T02:00:00.000Z',
    ],
  );
  await client.query(
    `INSERT INTO human_review_queue_items
       (id,risk_event_id,priority,state,assigned_reviewer_id,created_at,started_at,
        reviewed_at,resolution_code)
     VALUES ($1,$2,'high','pending',NULL,$3,NULL,NULL,NULL)`,
    [NF04_FIXTURE_IDS.reviewQueueItem, NF04_FIXTURE_IDS.riskEvent, at],
  );
  await client.query(
    `INSERT INTO audit_logs
       (id,actor_type,actor_id,action,resource_type,resource_id,idempotency_key,
        occurred_at,safe_metadata,retention_until)
     VALUES ($1,'system',NULL,'risk_event_created','risk_event',$2,$3,$4,'{}'::jsonb,$5)`,
    [
      NF04_FIXTURE_IDS.riskAudit,
      NF04_FIXTURE_IDS.riskEvent,
      'nf04:risk-event-created',
      at,
      '2026-12-12T02:00:00.000Z',
    ],
  );
}

async function insertConsent(
  client: PoolClient,
  input: {
    consentId: string;
    decisionId: string;
    operationId: string;
    consentType: 'terms_of_service' | 'privacy_policy';
    documentKey: string;
  },
): Promise<void> {
  const at = '2026-09-13T02:00:00.000Z';
  await client.query(
    `INSERT INTO consents
       (id,user_id,consent_type,consent_version,status,accepted_at,withdrawn_at,
        state_revision,effective_at)
     VALUES ($1,$2,$3,'1.1','accepted',$4,NULL,1,$4)`,
    [input.consentId, NF04_FIXTURE_IDS.user, input.consentType, at],
  );
  await client.query(
    `INSERT INTO consent_decisions
       (id,consent_id,user_id,consent_type,consent_version,operation_id,decision,
        outcome,prior_revision,resulting_revision,occurred_at,document_key,
        document_revision,target_acceptance_decision_id,decision_source)
     VALUES ($1,$2,$3,$4,'1.1',$5,'accepted','applied',0,1,$6,$7,
       'test-revision-2',NULL,'registration')`,
    [
      input.decisionId,
      input.consentId,
      NF04_FIXTURE_IDS.user,
      input.consentType,
      input.operationId,
      at,
      input.documentKey,
    ],
  );
}

async function verifyNf04Fixture(client: PoolClient, secrets?: Nf04FixtureSecrets): Promise<void> {
  const result = await client.query<{
    user_count: number;
    staff_count: number;
    consent_count: number;
    decision_count: number;
    session_count: number;
    conversation_count: number;
    message_count: number;
    turn_count: number;
    mood_count: number;
    quota_count: number;
    consumption_count: number;
    risk_count: number;
    queue_count: number;
    article_count: number;
    version_count: number;
    source_count: number;
    reference_count: number;
    audit_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM users WHERE id=$1) AS user_count,
       (SELECT count(*)::int FROM staff_principals p
          JOIN staff_role_grants g ON g.staff_principal_id=p.id
          WHERE p.id=$2 AND p.status='active' AND p.authorization_revision=1
          AND g.id=$20 AND g.role_key='access_administrator' AND g.grant_source='bootstrap'
          AND g.revoked_at IS NULL) AS staff_count,
       (SELECT count(*)::int FROM consents WHERE user_id=$1 AND status='accepted'
          AND consent_version='1.1' AND state_revision=1) AS consent_count,
       (SELECT count(*)::int FROM consent_decisions WHERE user_id=$1 AND outcome='applied'
          AND decision='accepted' AND document_revision='test-revision-2'
          AND decision_source='registration'
          AND ((consent_type='terms_of_service' AND document_key='synthetic.terms-of-service')
            OR (consent_type='privacy_policy' AND document_key='synthetic.privacy-policy'))
       ) AS decision_count,
       (SELECT count(*)::int FROM sessions WHERE id=$3 AND user_id=$1 AND revoked_at IS NULL) AS session_count,
       (SELECT count(*)::int FROM conversations WHERE id=$4 AND user_id=$1 AND is_saved=false
          AND deleted_at IS NULL) AS conversation_count,
       (SELECT count(*)::int FROM messages WHERE conversation_id=$4) AS message_count,
       (SELECT count(*)::int FROM ai_turns WHERE id=$5 AND status='completed'
          AND user_message_id=$17 AND assistant_message_id=$18
          AND prompt_key='supportive-chat' AND prompt_version='nf04-synthetic-v1') AS turn_count,
       (SELECT count(*)::int FROM mood_entries WHERE id=$6 AND user_id=$1
          AND mood_score=3 AND emotion='neutral' AND note='合成中性心情记录'
          AND state_revision=1) AS mood_count,
       (SELECT count(*)::int FROM daily_usage_quotas WHERE user_id=$1
          AND usage_date='2026-09-13' AND daily_limit=20 AND used_count=1) AS quota_count,
       (SELECT count(*)::int FROM quota_consumptions WHERE id=$7 AND user_id=$1
          AND usage_date='2026-09-13' AND idempotency_key='nf04-synthetic-quota-consumption') AS consumption_count,
       (SELECT count(*)::int FROM risk_events WHERE id=$8 AND user_id=$1
          AND risk_level='HIGH' AND is_incognito=false
          AND policy_version='nf04-fixture-v1'
          AND risk_categories=ARRAY['synthetic_fixture']::text[]
          AND reason_codes=ARRAY['SYNTHETIC_NON_CLINICAL_FIXTURE']::text[]) AS risk_count,
       (SELECT count(*)::int FROM human_review_queue_items WHERE id=$9 AND risk_event_id=$8
          AND priority='high' AND state='pending') AS queue_count,
       (SELECT count(*)::int FROM knowledge_articles WHERE id=$10 AND article_key=$11) AS article_count,
       (SELECT count(*)::int FROM knowledge_article_versions WHERE id=$12 AND publication_status='published'
          AND review_status='unverified' AND content_origin='synthetic_fixture'
          AND title='NF-04 合成中性知识' AND summary='仅用于数据库关系验证'
          AND content_blocks=$19::jsonb) AS version_count,
       (SELECT count(*)::int FROM knowledge_article_sources WHERE id=$13 AND article_version_id=$12
          AND ordinal=1 AND publisher_name='NF-04 Synthetic Publisher'
          AND source_title='Synthetic Source'
          AND source_url='https://fixture.invalid/nf04-source'
          AND source_version_label='fixture-v1'
          AND source_locator='synthetic locator') AS source_count,
       (SELECT count(*)::int FROM assistant_message_knowledge_references
          WHERE assistant_message_id=$14 AND article_version_id=$12) AS reference_count,
       (SELECT count(*)::int FROM audit_logs
          WHERE (id=$15 AND action='risk_event_created' AND resource_type='risk_event'
            AND resource_id=$8 AND idempotency_key='nf04:risk-event-created')
          OR (id=$16 AND action='staff_principal_bootstrapped'
            AND resource_type='staff_principal' AND resource_id=$2
            AND idempotency_key='nf04:staff-principal-bootstrapped')) AS audit_count`,
    [
      NF04_FIXTURE_IDS.user,
      NF04_FIXTURE_IDS.staffPrincipal,
      NF04_FIXTURE_IDS.session,
      NF04_FIXTURE_IDS.conversation,
      NF04_FIXTURE_IDS.aiTurn,
      NF04_FIXTURE_IDS.moodEntry,
      NF04_FIXTURE_IDS.quotaConsumption,
      NF04_FIXTURE_IDS.riskEvent,
      NF04_FIXTURE_IDS.reviewQueueItem,
      NF04_FIXTURE_IDS.knowledgeArticle,
      NF04_FIXTURE_VALUES.knowledgeArticleKey,
      NF04_FIXTURE_IDS.knowledgeVersion,
      NF04_FIXTURE_IDS.knowledgeSource,
      NF04_FIXTURE_IDS.assistantMessage,
      NF04_FIXTURE_IDS.riskAudit,
      NF04_FIXTURE_IDS.staffAudit,
      NF04_FIXTURE_IDS.userMessage,
      NF04_FIXTURE_IDS.assistantMessage,
      JSON.stringify([{ type: 'paragraph', text: '这是合成测试内容，不是正式知识文章。' }]),
      NF04_FIXTURE_IDS.staffRoleGrant,
    ],
  );
  const row = result.rows[0];
  const expected = {
    user_count: 1,
    staff_count: 1,
    consent_count: 2,
    decision_count: 2,
    session_count: 1,
    conversation_count: 1,
    message_count: 2,
    turn_count: 1,
    mood_count: 1,
    quota_count: 1,
    consumption_count: 1,
    risk_count: 1,
    queue_count: 1,
    article_count: 1,
    version_count: 1,
    source_count: 1,
    reference_count: 1,
    audit_count: 2,
  };
  if (
    !row ||
    Object.entries(expected).some(([key, value]) => row[key as keyof typeof row] !== value)
  ) {
    throw new Nf04FixtureError('Existing NF-04 fixture is incomplete or has conflicting identity');
  }

  const tableCounts = await client.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM password_credentials) AS password_credentials,
       (SELECT count(*)::int FROM sessions) AS sessions,
       (SELECT count(*)::int FROM staff_principals) AS staff_principals,
       (SELECT count(*)::int FROM staff_password_credentials) AS staff_password_credentials,
       (SELECT count(*)::int FROM staff_sessions) AS staff_sessions,
       (SELECT count(*)::int FROM staff_role_grants) AS staff_role_grants,
       (SELECT count(*)::int FROM age_verifications) AS age_verifications,
       (SELECT count(*)::int FROM consents) AS consents,
       (SELECT count(*)::int FROM consent_decisions) AS consent_decisions,
       (SELECT count(*)::int FROM daily_usage_quotas) AS daily_usage_quotas,
       (SELECT count(*)::int FROM quota_consumptions) AS quota_consumptions,
       (SELECT count(*)::int FROM mood_entries) AS mood_entries,
       (SELECT count(*)::int FROM knowledge_articles) AS knowledge_articles,
       (SELECT count(*)::int FROM knowledge_article_versions) AS knowledge_article_versions,
       (SELECT count(*)::int FROM knowledge_article_sources) AS knowledge_article_sources,
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM messages) AS messages,
       (SELECT count(*)::int FROM assistant_message_knowledge_references) AS knowledge_references,
       (SELECT count(*)::int FROM ai_turns) AS ai_turns,
       (SELECT count(*)::int FROM risk_events) AS risk_events,
       (SELECT count(*)::int FROM human_review_queue_items) AS review_queue_items,
       (SELECT count(*)::int FROM audit_logs) AS audit_logs`,
  );
  const exactTableCounts: Record<string, number> = {
    users: 1,
    password_credentials: 1,
    sessions: 1,
    staff_principals: 1,
    staff_password_credentials: 1,
    staff_sessions: 0,
    staff_role_grants: 1,
    age_verifications: 1,
    consents: 2,
    consent_decisions: 2,
    daily_usage_quotas: 1,
    quota_consumptions: 1,
    mood_entries: 1,
    knowledge_articles: 1,
    knowledge_article_versions: 1,
    knowledge_article_sources: 1,
    conversations: 1,
    messages: 2,
    knowledge_references: 1,
    ai_turns: 1,
    risk_events: 1,
    review_queue_items: 1,
    audit_logs: 2,
  };
  const counts = tableCounts.rows[0];
  if (
    !counts ||
    Object.entries(exactTableCounts).some(([table, count]) => counts[table] !== count)
  ) {
    throw new Nf04FixtureError('NF-04 database contains data outside the exact fixture bounds');
  }
  const size = await client.query<{ bytes: string }>(
    `SELECT coalesce(sum(pg_total_relation_size(format('%I.%I',schemaname,tablename))),0)::text AS bytes
     FROM pg_tables WHERE schemaname IN ('public','drizzle')`,
  );
  if (Number(size.rows[0]?.bytes ?? Number.POSITIVE_INFINITY) > 100 * 1024 * 1024) {
    throw new Nf04FixtureError('NF-04 fixture exceeds the 100 MiB database content bound');
  }

  const records = await client.query<{
    user_email: string;
    user_password_hash: string;
    session_token_hash: string;
    staff_email: string;
    staff_password_hash: string;
    user_content: string;
    assistant_content: string;
  }>(
    `SELECT pc.email AS user_email,pc.password_hash AS user_password_hash,
            s.token_hash AS session_token_hash,spc.email AS staff_email,
            spc.password_hash AS staff_password_hash,
            um.content AS user_content,am.content AS assistant_content
     FROM password_credentials pc
     JOIN sessions s ON s.user_id=pc.user_id AND s.id=$2
     JOIN staff_password_credentials spc ON spc.staff_principal_id=$3
     JOIN messages um ON um.id=$4
     JOIN messages am ON am.id=$5
     WHERE pc.user_id=$1`,
    [
      NF04_FIXTURE_IDS.user,
      NF04_FIXTURE_IDS.session,
      NF04_FIXTURE_IDS.staffPrincipal,
      NF04_FIXTURE_IDS.userMessage,
      NF04_FIXTURE_IDS.assistantMessage,
    ],
  );
  const record = records.rows[0];
  if (
    !record ||
    record.user_content !== NF04_FIXTURE_VALUES.conversationUserText ||
    record.assistant_content !== NF04_FIXTURE_VALUES.conversationAssistantText
  ) {
    throw new Nf04FixtureError('NF-04 fixture content is not the reviewed neutral fixture');
  }
  if (secrets) {
    const passwordsMatch =
      record.user_email === secrets.userEmail &&
      record.staff_email === secrets.staffEmail &&
      record.session_token_hash === hashToken(secrets.sessionToken) &&
      (await verify(record.user_password_hash, secrets.userPassword)) &&
      (await verify(record.staff_password_hash, secrets.staffPassword));
    if (!passwordsMatch) {
      throw new Nf04FixtureError('NF-04 fixture secrets do not match the existing fixture');
    }
  }
}

function fixtureResult(status: 'created' | 'existing'): Nf04FixtureLoadResult {
  return {
    status,
    userId: NF04_FIXTURE_IDS.user,
    sessionId: NF04_FIXTURE_IDS.session,
    accountDeletionOperationId: NF04_FIXTURE_IDS.accountDeletionOperation,
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
