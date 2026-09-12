import { z } from 'zod';
import { trustedTemplateKeySchema } from '../templates/trusted-safety-template.registry';

export const auditActorTypeSchema = z.enum(['system', 'user', 'human_reviewer', 'staff']);
export const auditResourceTypeSchema = z.enum([
  'ai_turn',
  'ai_generation',
  'conversation',
  'conversation_history',
  'risk_event',
  'review_queue_item',
  'mood_entry',
  'mood_history',
  'staff_principal',
  'staff_principal_query',
]);
export const auditActionSchema = z.enum([
  'conversation_deleted',
  'conversation_history_deleted',
  'risk_event_created',
  'risk_event_viewed',
  'crisis_flow_triggered',
  'review_queue_created',
  'review_started',
  'review_resolved',
  'safety_output_blocked',
  'safety_assessment_unavailable',
  'trusted_safety_response_created',
  'mood_entry_deleted',
  'mood_history_deleted',
  'staff_principal_bootstrapped',
  'staff_principal_created',
  'staff_role_granted',
  'staff_role_revoked',
  'staff_principal_disabled',
  'staff_sessions_revoked',
  'staff_directory_accessed',
]);

export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditResourceType = z.infer<typeof auditResourceTypeSchema>;
export type AuditAction = z.infer<typeof auditActionSchema>;

const emptyMetadataSchema = z.object({}).strict();
const templateMetadataSchema = z
  .object({
    templateKey: trustedTemplateKeySchema,
    templateVersion: z.string().min(1).max(64),
  })
  .strict();
const reviewQueueCreatedMetadataSchema = z
  .object({
    priority: z.enum(['high', 'urgent']),
  })
  .strict();
const reviewResolvedMetadataSchema = z
  .object({
    resolutionCode: z.enum([
      'confirmed_risk',
      'false_positive',
      'unable_to_determine',
      'action_recorded',
    ]),
  })
  .strict();
const failureMetadataSchema = z
  .object({
    failureCategory: z.enum(['timeout', 'provider', 'malformed', 'unsupported', 'internal']),
  })
  .strict();
const conversationHistoryDeletedMetadataSchema = z
  .object({
    conversationCount: z.number().int().positive(),
    messageCount: z.number().int().nonnegative(),
  })
  .strict();
const moodHistoryDeletedMetadataSchema = z
  .object({ entryCount: z.number().int().positive() })
  .strict();
const staffBootstrapMetadataSchema = z
  .object({ roleKey: z.literal('access_administrator') })
  .strict();
const staffRoleMetadataSchema = z
  .object({
    roleKey: z.enum([
      'access_administrator',
      'safety_reviewer',
      'knowledge_editor',
      'knowledge_source_reviewer',
      'knowledge_publisher',
      'audit_reader',
      'ai_quality_reviewer',
    ]),
    resultingAuthorizationRevision: z.number().int().positive(),
  })
  .strict();
const staffRevisionMetadataSchema = z
  .object({ resultingAuthorizationRevision: z.number().int().positive() })
  .strict();
const staffSessionsRevokedMetadataSchema = z
  .object({
    sessionCount: z.number().int().nonnegative(),
  })
  .strict();
const staffDirectoryMetadataSchema = z
  .object({
    filterCategory: z.enum(['all', 'id']),
    returnedCount: z.number().int().nonnegative(),
  })
  .strict();

export function parseAuditMetadata(
  action: AuditAction,
  metadata: unknown,
): Record<string, string | number | boolean | null> {
  if (action === 'crisis_flow_triggered' || action === 'trusted_safety_response_created') {
    return templateMetadataSchema.parse(metadata);
  }
  if (action === 'review_queue_created') {
    return reviewQueueCreatedMetadataSchema.parse(metadata);
  }
  if (action === 'review_resolved') {
    return reviewResolvedMetadataSchema.parse(metadata);
  }
  if (action === 'safety_assessment_unavailable') {
    return failureMetadataSchema.parse(metadata);
  }
  if (action === 'conversation_history_deleted') {
    return conversationHistoryDeletedMetadataSchema.parse(metadata);
  }
  if (action === 'mood_history_deleted') {
    return moodHistoryDeletedMetadataSchema.parse(metadata);
  }
  if (action === 'staff_principal_bootstrapped') {
    return staffBootstrapMetadataSchema.parse(metadata);
  }
  if (action === 'staff_role_granted' || action === 'staff_role_revoked') {
    return staffRoleMetadataSchema.parse(metadata);
  }
  if (action === 'staff_principal_disabled') {
    return staffRevisionMetadataSchema.parse(metadata);
  }
  if (action === 'staff_sessions_revoked') {
    return staffSessionsRevokedMetadataSchema.parse(metadata);
  }
  if (action === 'staff_directory_accessed') {
    return staffDirectoryMetadataSchema.parse(metadata);
  }
  return emptyMetadataSchema.parse(metadata);
}
