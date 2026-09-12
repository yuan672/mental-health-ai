import { z } from 'zod';

export const staffRoleSchema = z.enum([
  'access_administrator',
  'safety_reviewer',
  'knowledge_editor',
  'knowledge_source_reviewer',
  'knowledge_publisher',
  'audit_reader',
  'ai_quality_reviewer',
]);

export type StaffRole = z.infer<typeof staffRoleSchema>;

export const staffPermissionSchema = z.enum([
  'staff_principal:create',
  'staff_principal:read',
  'staff_role:grant',
  'staff_role:revoke',
  'staff_principal:disable',
  'staff_session:revoke',
  'risk_event:read',
  'review_queue:claim',
  'review_queue:resolve',
  'knowledge:draft_write',
  'knowledge:source_review',
  'knowledge:publish',
  'audit:read',
  'ai_quality:read_metadata',
]);

export type StaffPermission = z.infer<typeof staffPermissionSchema>;

export const STAFF_ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffPermission[]>> = {
  access_administrator: [
    'staff_principal:create',
    'staff_principal:read',
    'staff_role:grant',
    'staff_role:revoke',
    'staff_principal:disable',
    'staff_session:revoke',
  ],
  safety_reviewer: ['risk_event:read', 'review_queue:claim', 'review_queue:resolve'],
  knowledge_editor: ['knowledge:draft_write'],
  knowledge_source_reviewer: ['knowledge:source_review'],
  knowledge_publisher: ['knowledge:publish'],
  audit_reader: ['audit:read'],
  ai_quality_reviewer: ['ai_quality:read_metadata'],
};

export type StaffAuthorizationContext = Readonly<{
  id: string;
  sessionId: string;
  authorizationRevision: number;
}>;

export function rolesGrantPermission(
  roleKeys: readonly StaffRole[],
  permission: StaffPermission,
): boolean {
  return roleKeys.some((role) => STAFF_ROLE_PERMISSIONS[role].includes(permission));
}
