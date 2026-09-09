import type { Request } from 'express';
import type { SessionRecord } from '../users/users.repository';

export type AuthenticatedRequest = Request & {
  authenticatedSession: SessionRecord;
};
