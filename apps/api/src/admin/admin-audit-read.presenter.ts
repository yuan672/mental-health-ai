import {
  adminAuditRecordSchema,
  storedAuditReadRowSchema,
  type AdminAuditRecord,
  type StoredAuditReadRow,
} from './admin-audit-read.schemas';

/**
 * Builds only the public allowlisted shape. In particular, it never copies the
 * stored idempotency key or spreads the stored metadata/object into a response.
 */
export function presentAdminAuditRecord(input: StoredAuditReadRow): AdminAuditRecord {
  const row = storedAuditReadRowSchema.parse(input);
  return adminAuditRecordSchema.parse({
    id: row.id,
    actor: { type: row.actorType, id: row.actorId },
    action: row.action,
    resource: { type: row.resourceType, id: row.resourceId },
    occurredAt: row.occurredAt.toISOString(),
    retentionUntil: row.retentionUntil.toISOString(),
    safeMetadata: row.safeMetadata,
  });
}
