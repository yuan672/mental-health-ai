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
@UseGuards(AdminAuthEnabledGuard)
@UseInterceptors(AdminNoStoreInterceptor)
export class AdminController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly access: StaffAccessService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @UseGuards(StaffTrustedOriginGuard)
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
}
