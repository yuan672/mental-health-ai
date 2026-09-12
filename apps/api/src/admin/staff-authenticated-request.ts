import type { Request } from 'express';
import type { StaffAuthorizationContext, StaffRole } from './staff-access.types';

export type StaffSessionView = StaffAuthorizationContext &
  Readonly<{
    expiresAt: Date;
    roleKeys: readonly StaffRole[];
  }>;

export type StaffAuthenticatedRequest = Request & {
  staffSession: StaffSessionView;
};
