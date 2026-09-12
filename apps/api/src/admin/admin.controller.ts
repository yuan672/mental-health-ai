import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { AdminAuthEnabledGuard } from './admin-auth-enabled.guard';
import { AdminNoStoreInterceptor } from './admin-no-store.interceptor';
import type { StaffAuthenticatedRequest, StaffSessionView } from './staff-authenticated-request';
import { StaffAccessService } from './staff-access.service';
import { AdminSafetyReviewService } from './admin-safety-review.service';
import { StaffAuthService } from './staff-auth.service';
import { clearStaffCookies, setStaffCookies } from './staff-cookies';
import { StaffCsrfGuard } from './staff-csrf.guard';
import { StaffSessionGuard } from './staff-session.guard';
import { StaffTrustedOriginGuard } from './staff-trusted-origin.guard';
import {
  createStaffPrincipalSchema,
  expectedAuthorizationRevisionSchema,
  staffListQuerySchema,
  staffLoginSchema,
  staffPrincipalIdSchema,
  staffPrincipalViewSchema,
  staffRoleSchema,
  staffSessionDataSchema,
  type CreateStaffPrincipalRequest,
  type ExpectedAuthorizationRevisionRequest,
  type StaffLoginRequest,
} from './staff.schemas';
import type { StaffPrincipalState } from './staff.repository';
import { AdminKnowledgeService } from './admin-knowledge.service';
import {
  adminKnowledgeCandidateDataSchema,
  adminKnowledgeCandidateSchema,
  adminKnowledgeDirectoryDataSchema,
  adminKnowledgeExpectedRevisionSchema,
  adminKnowledgeListQuerySchema,
  adminKnowledgeMutationDataSchema,
  adminKnowledgePublicationStateDataSchema,
  adminKnowledgeReplaceSchema,
  adminKnowledgeSourceReviewDataSchema,
  adminKnowledgeSourceReviewSchema,
  adminKnowledgeStatusDataSchema,
  adminKnowledgeVersionParamsSchema,
  type AdminKnowledgeCandidate,
  type AdminKnowledgeExpectedRevisionRequest,
  type AdminKnowledgeListQuery,
  type AdminKnowledgeReplaceRequest,
  type AdminKnowledgeSourceReviewRequest,
  type AdminKnowledgeVersionParams,
} from './admin-knowledge.schemas';
import {
  adminResourceIdSchema,
  adminReviewQueueClaimSchema,
  adminReviewQueueListDataSchema,
  adminReviewQueueListQuerySchema,
  adminReviewQueueMutationDataSchema,
  adminReviewQueueResolveSchema,
  adminRiskEventDetailDataSchema,
  adminRiskEventListDataSchema,
  adminRiskEventListQuerySchema,
  type AdminReviewQueueListQuery,
  type AdminReviewQueueResolveRequest,
  type AdminRiskEventListQuery,
} from './admin-safety-review.schemas';

function principalView(principal: StaffPrincipalState) {
  return staffPrincipalViewSchema.parse({
    id: principal.id,
    email: principal.email,
    status: principal.status,
    authorizationRevision: principal.authorizationRevision,
    roleKeys: principal.roleKeys,
    createdAt: principal.createdAt.toISOString(),
    disabledAt: principal.disabledAt?.toISOString() ?? null,
  });
}

function sessionView(session: StaffSessionView) {
  return staffSessionDataSchema.parse({
    principal: {
      id: session.id,
      roleKeys: session.roleKeys,
      authorizationRevision: session.authorizationRevision,
    },
    session: { id: session.sessionId, expiresAt: session.expiresAt.toISOString() },
  });
}

@Controller('admin')
@UseGuards(AdminAuthEnabledGuard, StaffTrustedOriginGuard)
@UseInterceptors(AdminNoStoreInterceptor)
export class AdminController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly access: StaffAccessService,
    private readonly safetyReview: AdminSafetyReviewService,
    private readonly knowledge: AdminKnowledgeService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(staffLoginSchema)) body: StaffLoginRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.login(body.email, body.password);
    setStaffCookies(response, session.rawToken, session.csrfToken, session.expiresAt);
    return { success: true, data: sessionView(session) };
  }

  @Get('auth/session')
  @UseGuards(StaffSessionGuard)
  session(@Req() request: StaffAuthenticatedRequest) {
    return { success: true, data: sessionView(request.staffSession) };
  }

  @Post('auth/logout')
  @HttpCode(200)
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async logout(
    @Req() request: StaffAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(request.staffSession);
    clearStaffCookies(response);
    return { success: true, data: { loggedOut: true } };
  }

  @Post('staff-principals')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async create(
    @Req() request: StaffAuthenticatedRequest,
    @Body(new ZodValidationPipe(createStaffPrincipalSchema)) body: CreateStaffPrincipalRequest,
  ) {
    const result = await this.access.create(request.staffSession, body);
    return {
      success: true,
      data: { outcome: result.outcome, principal: principalView(result.principal) },
    };
  }

  @Get('staff-principals')
  @UseGuards(StaffSessionGuard)
  async list(
    @Req() request: StaffAuthenticatedRequest,
    @Query(new ZodValidationPipe(staffListQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const result = await this.access.list(request.staffSession, query.limit, query.cursor);
    return {
      success: true,
      data: { principals: result.principals.map(principalView), nextCursor: result.nextCursor },
    };
  }

  @Get('staff-principals/:id')
  @UseGuards(StaffSessionGuard)
  async get(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(staffPrincipalIdSchema)) id: string,
  ) {
    return {
      success: true,
      data: { principal: principalView(await this.access.get(request.staffSession, id)) },
    };
  }

  @Put('staff-principals/:id/roles/:roleKey')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async grant(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(staffPrincipalIdSchema)) id: string,
    @Param('roleKey', new ZodValidationPipe(staffRoleSchema))
    roleKey: Parameters<StaffAccessService['grantRole']>[2],
    @Body(new ZodValidationPipe(expectedAuthorizationRevisionSchema))
    body: ExpectedAuthorizationRevisionRequest,
  ) {
    const result = await this.access.grantRole(
      request.staffSession,
      id,
      roleKey,
      body.expectedAuthorizationRevision,
    );
    return { success: true, data: { ...result, principal: principalView(result.principal) } };
  }

  @Delete('staff-principals/:id/roles/:roleKey')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async revokeRole(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(staffPrincipalIdSchema)) id: string,
    @Param('roleKey', new ZodValidationPipe(staffRoleSchema))
    roleKey: Parameters<StaffAccessService['revokeRole']>[2],
    @Body(new ZodValidationPipe(expectedAuthorizationRevisionSchema))
    body: ExpectedAuthorizationRevisionRequest,
  ) {
    const result = await this.access.revokeRole(
      request.staffSession,
      id,
      roleKey,
      body.expectedAuthorizationRevision,
    );
    return { success: true, data: { ...result, principal: principalView(result.principal) } };
  }

  @Post('staff-principals/:id/disable')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async disable(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(staffPrincipalIdSchema)) id: string,
    @Body(new ZodValidationPipe(expectedAuthorizationRevisionSchema))
    body: ExpectedAuthorizationRevisionRequest,
  ) {
    const result = await this.access.disable(
      request.staffSession,
      id,
      body.expectedAuthorizationRevision,
    );
    return { success: true, data: { ...result, principal: principalView(result.principal) } };
  }

  @Post('staff-principals/:id/revoke-sessions')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async revokeSessions(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(staffPrincipalIdSchema)) id: string,
    @Body(new ZodValidationPipe(expectedAuthorizationRevisionSchema))
    body: ExpectedAuthorizationRevisionRequest,
  ) {
    const result = await this.access.revokeSessions(
      request.staffSession,
      id,
      body.expectedAuthorizationRevision,
    );
    return { success: true, data: { ...result, principal: principalView(result.principal) } };
  }

  @Get('risk-events')
  @UseGuards(StaffSessionGuard)
  async listRiskEvents(
    @Req() request: StaffAuthenticatedRequest,
    @Query(new ZodValidationPipe(adminRiskEventListQuerySchema)) query: AdminRiskEventListQuery,
  ) {
    return {
      success: true,
      data: adminRiskEventListDataSchema.parse(
        await this.safetyReview.listRiskEvents(request.staffSession, query),
      ),
    };
  }

  @Get('risk-events/:id')
  @UseGuards(StaffSessionGuard)
  async getRiskEvent(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(adminResourceIdSchema)) id: string,
  ) {
    return {
      success: true,
      data: adminRiskEventDetailDataSchema.parse(
        await this.safetyReview.getRiskEvent(request.staffSession, id),
      ),
    };
  }

  @Get('review-queue')
  @UseGuards(StaffSessionGuard)
  async listReviewQueue(
    @Req() request: StaffAuthenticatedRequest,
    @Query(new ZodValidationPipe(adminReviewQueueListQuerySchema)) query: AdminReviewQueueListQuery,
  ) {
    return {
      success: true,
      data: adminReviewQueueListDataSchema.parse(
        await this.safetyReview.listReviewQueue(request.staffSession, query),
      ),
    };
  }

  @Post('review-queue/:id/claim')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async claimReviewQueueItem(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(adminResourceIdSchema)) id: string,
    @Body(new ZodValidationPipe(adminReviewQueueClaimSchema)) body: Record<string, never>,
  ) {
    void body;
    return {
      success: true,
      data: adminReviewQueueMutationDataSchema.parse(
        await this.safetyReview.claim(request.staffSession, id),
      ),
    };
  }

  @Post('review-queue/:id/resolve')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async resolveReviewQueueItem(
    @Req() request: StaffAuthenticatedRequest,
    @Param('id', new ZodValidationPipe(adminResourceIdSchema)) id: string,
    @Body(new ZodValidationPipe(adminReviewQueueResolveSchema))
    body: AdminReviewQueueResolveRequest,
  ) {
    return {
      success: true,
      data: adminReviewQueueMutationDataSchema.parse(
        await this.safetyReview.resolve(request.staffSession, id, body.resolutionCode),
      ),
    };
  }

  @Get('knowledge/articles')
  @UseGuards(StaffSessionGuard)
  async listKnowledgeArticles(
    @Req() request: StaffAuthenticatedRequest,
    @Query(new ZodValidationPipe(adminKnowledgeListQuerySchema)) query: AdminKnowledgeListQuery,
  ) {
    return {
      success: true,
      data: adminKnowledgeDirectoryDataSchema.parse(
        await this.knowledge.list(request.staffSession, query),
      ),
    };
  }

  @Get('knowledge/articles/:articleKey/versions/:version/status')
  @UseGuards(StaffSessionGuard)
  async getKnowledgeVersionStatus(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
  ) {
    return {
      success: true,
      data: adminKnowledgeStatusDataSchema.parse(
        await this.knowledge.getStatus(request.staffSession, params.articleKey, params.version),
      ),
    };
  }

  @Post('knowledge/articles/:articleKey/versions/:version')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async createKnowledgeDraft(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
    @Body(new ZodValidationPipe(adminKnowledgeCandidateSchema)) body: AdminKnowledgeCandidate,
  ) {
    return {
      success: true,
      data: adminKnowledgeMutationDataSchema.parse(
        await this.knowledge.create(request.staffSession, params.articleKey, params.version, body),
      ),
    };
  }

  @Get('knowledge/articles/:articleKey/versions/:version/draft')
  @UseGuards(StaffSessionGuard)
  async getKnowledgeDraft(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
  ) {
    return {
      success: true,
      data: adminKnowledgeCandidateDataSchema.parse(
        await this.knowledge.getDraft(request.staffSession, params.articleKey, params.version),
      ),
    };
  }

  @Put('knowledge/articles/:articleKey/versions/:version/draft')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async replaceKnowledgeDraft(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
    @Body(new ZodValidationPipe(adminKnowledgeReplaceSchema)) body: AdminKnowledgeReplaceRequest,
  ) {
    return {
      success: true,
      data: adminKnowledgeMutationDataSchema.parse(
        await this.knowledge.replace(
          request.staffSession,
          params.articleKey,
          params.version,
          body.expectedDraftRevision,
          body.candidate,
        ),
      ),
    };
  }

  @Get('knowledge/articles/:articleKey/versions/:version/review-candidate')
  @UseGuards(StaffSessionGuard)
  async getKnowledgeReviewCandidate(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
  ) {
    return {
      success: true,
      data: adminKnowledgeCandidateDataSchema.parse(
        await this.knowledge.getReviewCandidate(
          request.staffSession,
          params.articleKey,
          params.version,
        ),
      ),
    };
  }

  @Post('knowledge/articles/:articleKey/versions/:version/source-review')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async verifyKnowledgeSources(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
    @Body(new ZodValidationPipe(adminKnowledgeSourceReviewSchema))
    body: AdminKnowledgeSourceReviewRequest,
  ) {
    return {
      success: true,
      data: adminKnowledgeSourceReviewDataSchema.parse(
        await this.knowledge.sourceReview(
          request.staffSession,
          params.articleKey,
          params.version,
          body.expectedDraftRevision,
        ),
      ),
    };
  }

  @Get('knowledge/articles/:articleKey/versions/:version/publication-state')
  @UseGuards(StaffSessionGuard)
  async getKnowledgePublicationState(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
  ) {
    return {
      success: true,
      data: adminKnowledgePublicationStateDataSchema.parse(
        await this.knowledge.getPublicationState(
          request.staffSession,
          params.articleKey,
          params.version,
        ),
      ),
    };
  }

  @Post('knowledge/articles/:articleKey/versions/:version/publish')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async publishKnowledgeVersion(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
    @Body(new ZodValidationPipe(adminKnowledgeExpectedRevisionSchema))
    body: AdminKnowledgeExpectedRevisionRequest,
  ) {
    return {
      success: true,
      data: adminKnowledgeMutationDataSchema.parse(
        await this.knowledge.publish(
          request.staffSession,
          params.articleKey,
          params.version,
          body.expectedDraftRevision,
        ),
      ),
    };
  }

  @Post('knowledge/articles/:articleKey/versions/:version/withdraw')
  @UseGuards(StaffSessionGuard, StaffCsrfGuard)
  async withdrawKnowledgeVersion(
    @Req() request: StaffAuthenticatedRequest,
    @Param(new ZodValidationPipe(adminKnowledgeVersionParamsSchema))
    params: AdminKnowledgeVersionParams,
    @Body(new ZodValidationPipe(adminKnowledgeExpectedRevisionSchema))
    body: AdminKnowledgeExpectedRevisionRequest,
  ) {
    return {
      success: true,
      data: adminKnowledgeMutationDataSchema.parse(
        await this.knowledge.withdraw(
          request.staffSession,
          params.articleKey,
          params.version,
          body.expectedDraftRevision,
        ),
      ),
    };
  }
}
