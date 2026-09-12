import type { ApiSuccessResponse } from './index.js';

export type StaffRole =
  | 'access_administrator'
  | 'safety_reviewer'
  | 'knowledge_editor'
  | 'knowledge_source_reviewer'
  | 'knowledge_publisher'
  | 'audit_reader'
  | 'ai_quality_reviewer';

export type StaffPrincipal = {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  authorizationRevision: number;
  roleKeys: StaffRole[];
  createdAt: string;
  disabledAt: string | null;
};

export type StaffSessionResponse = ApiSuccessResponse<{
  principal: {
    id: string;
    roleKeys: StaffRole[];
    authorizationRevision: number;
  };
  session: { id: string; expiresAt: string };
}>;

export type StaffPrincipalResponse = ApiSuccessResponse<{ principal: StaffPrincipal }>;
export type StaffPrincipalMutationResponse = ApiSuccessResponse<{
  outcome: 'applied' | 'no_change';
  principal: StaffPrincipal;
  sessionCount?: number;
}>;
export type StaffPrincipalListResponse = ApiSuccessResponse<{
  principals: StaffPrincipal[];
  nextCursor: string | null;
}>;
