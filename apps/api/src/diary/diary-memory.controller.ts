import { Body, Controller, Get, Header, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { HttpPrincipal } from '../http-abuse/http-abuse.metadata';
import {
  diaryAccessSchema,
  DiaryMemoryService,
  type DiaryAccessInput,
} from './diary-memory.service';
const turnParams = z.object({ turnId: z.uuid() }).strict();
@Controller('diary/ai')
@UseGuards(AuthenticatedSessionGuard)
@HttpPrincipal('principal_general')
export class DiaryMemoryController {
  constructor(private readonly memory: DiaryMemoryService) {}
  @Get('access')
  @Header('Cache-Control', 'private, no-store')
  async get(@Req() req: AuthenticatedRequest) {
    return {
      success: true,
      data: { policy: await this.memory.policy(req.authenticatedSession.userId) },
    };
  }
  @Patch('access')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  async update(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(diaryAccessSchema)) input: DiaryAccessInput,
  ) {
    return {
      success: true,
      data: { policy: await this.memory.updatePolicy(req.authenticatedSession.userId, input) },
    };
  }
  @Get('turns/:turnId')
  @Header('Cache-Control', 'private, no-store')
  async references(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(turnParams)) params: z.infer<typeof turnParams>,
  ) {
    return {
      success: true,
      data: await this.memory.references(req.authenticatedSession.userId, params.turnId),
    };
  }
}
