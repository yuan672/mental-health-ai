import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { QuotaResponse } from '@mental-health/types';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { HttpPrincipal } from '../http-abuse/http-abuse.metadata';
import { QuotaService } from './quota.service';

@Controller('quota')
@UseGuards(AuthenticatedSessionGuard)
@HttpPrincipal('principal_general')
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async get(@Req() request: AuthenticatedRequest): Promise<QuotaResponse> {
    const usage = await this.quota.getUsage(request.authenticatedSession.userId);
    return {
      success: true,
      data: {
        quota: {
          dailyLimit: usage.dailyLimit,
          used: usage.usedCount,
          remaining: usage.remaining,
          usageDate: usage.usageDate,
        },
      },
    };
  }
}
