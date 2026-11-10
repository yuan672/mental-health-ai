import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { AuthenticatedSessionGuard } from '../auth/authenticated-session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { HttpPrincipal } from '../http-abuse/http-abuse.metadata';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { DiaryService } from './diary.service';
import { ValidationError } from '../common/errors';
import { MAX_AVATAR_BYTES } from './profile-avatar';
import {
  notebookCreateSchema,
  notebookParamsSchema,
  notebookUpdateSchema,
  pageListSchema,
  pageParamsSchema,
  pageWriteSchema,
  photoParamsSchema,
  photoUploadSchema,
  revisionSchema,
  settingsUpdateSchema,
  settingsMultipartSchema,
  avatarParamsSchema,
} from './diary.schemas';

@Controller('diary/notebooks')
@UseGuards(AuthenticatedSessionGuard)
@HttpPrincipal('principal_general')
export class DiaryController {
  constructor(private readonly diary: DiaryService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Req() req: AuthenticatedRequest) {
    return this.diary.list(req.authenticatedSession.userId);
  }
  @Post()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  create(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(notebookCreateSchema)) body: z.infer<typeof notebookCreateSchema>,
  ) {
    return this.diary.create(req.authenticatedSession.userId, body);
  }
  @Get(':bookId')
  @Header('Cache-Control', 'private, no-store')
  get(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(notebookParamsSchema)) p: z.infer<typeof notebookParamsSchema>,
    @Query(new ZodValidationPipe(pageListSchema)) q: z.infer<typeof pageListSchema>,
  ) {
    return this.diary.listPages(req.authenticatedSession.userId, p.bookId, q.before);
  }
  @Patch(':bookId')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  update(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(notebookParamsSchema)) p: z.infer<typeof notebookParamsSchema>,
    @Body(new ZodValidationPipe(notebookUpdateSchema)) body: z.infer<typeof notebookUpdateSchema>,
  ) {
    return this.diary.update(req.authenticatedSession.userId, p.bookId, body);
  }
  @Delete(':bookId')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(notebookParamsSchema)) p: z.infer<typeof notebookParamsSchema>,
    @Body(new ZodValidationPipe(revisionSchema)) body: z.infer<typeof revisionSchema>,
  ) {
    return this.diary.remove(req.authenticatedSession.userId, p.bookId, body.expectedRevision);
  }
  @Get(':bookId/entries/:day')
  @Header('Cache-Control', 'private, no-store')
  page(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(pageParamsSchema)) p: z.infer<typeof pageParamsSchema>,
  ) {
    return this.diary.page(req.authenticatedSession.userId, p.bookId, p.day);
  }
  @Post(':bookId/entries/:day')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  write(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(pageParamsSchema)) p: z.infer<typeof pageParamsSchema>,
    @Body(new ZodValidationPipe(pageWriteSchema)) body: z.infer<typeof pageWriteSchema>,
  ) {
    return this.diary.write(req.authenticatedSession.userId, p.bookId, p.day, body);
  }
  @Delete(':bookId/entries/:day')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  deletePage(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(pageParamsSchema)) p: z.infer<typeof pageParamsSchema>,
    @Body(new ZodValidationPipe(revisionSchema)) body: z.infer<typeof revisionSchema>,
  ) {
    return this.diary.remove(
      req.authenticatedSession.userId,
      p.bookId,
      body.expectedRevision,
      p.day,
    );
  }
  @Post(':bookId/entries/:day/photos')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1, fieldSize: 64 },
    }),
  )
  upload(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(pageParamsSchema)) p: z.infer<typeof pageParamsSchema>,
    @Body(new ZodValidationPipe(photoUploadSchema)) body: z.infer<typeof photoUploadSchema>,
    @UploadedFile() file: { buffer: Buffer; originalname: string; size: number } | undefined,
  ) {
    return this.diary.upload(req.authenticatedSession.userId, p.bookId, p.day, body.photoId, file);
  }
  @Get(':bookId/photos/:photoId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  photo(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(photoParamsSchema)) p: z.infer<typeof photoParamsSchema>,
  ) {
    return this.diary.photo(req.authenticatedSession.userId, p.bookId, p.photoId);
  }
  @Delete(':bookId/photos/:photoId')
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  deletePhoto(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(photoParamsSchema)) p: z.infer<typeof photoParamsSchema>,
  ) {
    return this.diary.deletePhoto(req.authenticatedSession.userId, p.bookId, p.photoId);
  }
}

@Controller('profile/settings')
@UseGuards(AuthenticatedSessionGuard)
@HttpPrincipal('principal_general')
export class PersonalSettingsController {
  constructor(private readonly diary: DiaryService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  get(@Req() req: AuthenticatedRequest) {
    return this.diary.settings(req.authenticatedSession.userId);
  }
  @Patch()
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  update(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(settingsUpdateSchema)) body: z.infer<typeof settingsUpdateSchema>,
  ) {
    return this.diary.updateSettings(req.authenticatedSession.userId, body);
  }
  @Post()
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 1, fieldSize: 16384 },
    }),
  )
  upload(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(settingsMultipartSchema))
    body: z.infer<typeof settingsMultipartSchema>,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    if (!file) throw new ValidationError('请选择头像图片');
    return this.diary.updateSettings(req.authenticatedSession.userId, body.settings, file);
  }
  @Get('avatar/:avatarId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  avatar(
    @Req() req: AuthenticatedRequest,
    @Param(new ZodValidationPipe(avatarParamsSchema)) p: z.infer<typeof avatarParamsSchema>,
  ) {
    return this.diary.avatar(req.authenticatedSession.userId, p.avatarId);
  }
}
