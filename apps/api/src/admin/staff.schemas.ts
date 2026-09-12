import { z } from 'zod';
import { passwordSchema } from '../auth/auth.schemas';
import { staffRoleSchema } from './staff-access.types';

export const staffEmailSchema = z.string().trim().toLowerCase().email().max(320);
export const staffLoginSchema = z
  .object({ email: staffEmailSchema, password: z.string().min(1).max(128) })
  .strict();
export const createStaffPrincipalSchema = z
  .object({
    staffPrincipalId: z.string().uuid(),
    email: staffEmailSchema,
    initialPassword: passwordSchema,
  })
  .strict();
export const expectedAuthorizationRevisionSchema = z
  .object({ expectedAuthorizationRevision: z.number().int().positive() })
  .strict();
export const staffPrincipalIdSchema = z.string().uuid();
export const staffListQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const staffPrincipalViewSchema = z
  .object({
    id: z.string().uuid(),
    email: staffEmailSchema,
    status: z.enum(['active', 'disabled']),
    authorizationRevision: z.number().int().positive(),
    roleKeys: z.array(staffRoleSchema),
    createdAt: z.string().datetime({ offset: true }),
    disabledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export const staffSessionDataSchema = z
  .object({
    principal: z
      .object({
        id: z.string().uuid(),
        roleKeys: z.array(staffRoleSchema),
        authorizationRevision: z.number().int().positive(),
      })
      .strict(),
    session: z
      .object({ id: z.string().uuid(), expiresAt: z.string().datetime({ offset: true }) })
      .strict(),
  })
  .strict();

export type StaffLoginRequest = z.infer<typeof staffLoginSchema>;
export type CreateStaffPrincipalRequest = z.infer<typeof createStaffPrincipalSchema>;
export type ExpectedAuthorizationRevisionRequest = z.infer<
  typeof expectedAuthorizationRevisionSchema
>;
export { staffRoleSchema };
