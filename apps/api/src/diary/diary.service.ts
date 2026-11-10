import {
  and,
  desc,
  eq,
  lt,
  diaryNotebooks,
  diaryPages,
  diaryPhotos,
  personalSettings,
  users,
  type AppTransaction,
} from '@mental-health/database';
import type { DiaryCat } from '@mental-health/types';
import { Injectable, StreamableFile } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { DatabaseService } from '../database/database.service';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import { photoMime, type DiaryWriteInput, type SettingsWriteInput } from './diary.schemas';
import { normalizeAvatar } from './profile-avatar';

const ok = <T>(data: T) => ({ success: true as const, data });
const notebookView = (row: typeof diaryNotebooks.$inferSelect) => ({
  id: row.id,
  name: row.name,
  cat: row.cat,
  revision: row.revision,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const photoView = (
  row: Pick<typeof diaryPhotos.$inferSelect, 'id' | 'name' | 'mime' | 'size'>,
) => ({ id: row.id, name: row.name, mime: row.mime, size: row.size });

@Injectable()
export class DiaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditLogRepository,
  ) {}
  private async owned(userId: string, bookId: string, tx?: AppTransaction) {
    const query = (tx ?? this.database.database)
      .select()
      .from(diaryNotebooks)
      .where(and(eq(diaryNotebooks.id, bookId), eq(diaryNotebooks.userId, userId)))
      .limit(1);
    const [book] = await (tx ? query.for('update') : query);
    if (!book) throw new NotFoundError('日记本不存在');
    return book;
  }
  async list(userId: string) {
    const books = await this.database.database
      .select()
      .from(diaryNotebooks)
      .where(eq(diaryNotebooks.userId, userId))
      .orderBy(desc(diaryNotebooks.updatedAt))
      .limit(50);
    return ok({ books: books.map(notebookView) });
  }
  async create(userId: string, input: { id: string; name: string; cat: DiaryCat }) {
    return this.database.database.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [existing] = await tx
        .select()
        .from(diaryNotebooks)
        .where(eq(diaryNotebooks.id, input.id));
      if (existing) {
        if (existing.userId !== userId) throw new NotFoundError();
        return ok({ book: notebookView(existing) });
      }
      const current = await tx
        .select({ id: diaryNotebooks.id })
        .from(diaryNotebooks)
        .where(eq(diaryNotebooks.userId, userId))
        .limit(50);
      if (current.length >= 50) throw new ValidationError('最多保存 50 本日记本');
      const [book] = await tx
        .insert(diaryNotebooks)
        .values({ ...input, userId })
        .returning();
      if (!book) throw new Error('Notebook insert failed');
      return ok({ book: notebookView(book) });
    });
  }
  async update(
    userId: string,
    id: string,
    input: { name: string; cat: DiaryCat; expectedRevision: number },
  ) {
    return this.database.database.transaction(async (tx) => {
      const current = await this.owned(userId, id, tx);
      if (current.revision !== input.expectedRevision)
        throw new ConflictError('日记本有新的修改，请重新读取后再决定');
      const [book] = await tx
        .update(diaryNotebooks)
        .set({
          name: input.name,
          cat: input.cat,
          revision: current.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(diaryNotebooks.id, id))
        .returning();
      if (!book) throw new NotFoundError();
      return ok({ book: notebookView(book) });
    });
  }
  async listPages(userId: string, id: string, before?: string) {
    const book = await this.owned(userId, id);
    const pages = await this.database.database
      .select({
        day: diaryPages.day,
        saved: diaryPages.saved,
        draft: diaryPages.draft,
        revision: diaryPages.revision,
      })
      .from(diaryPages)
      .where(and(eq(diaryPages.notebookId, id), before ? lt(diaryPages.day, before) : undefined))
      .orderBy(desc(diaryPages.day))
      .limit(31);
    const slice = pages.slice(0, 30);
    return ok({
      book: notebookView(book),
      entries: slice.map((page) => ({
        day: page.day,
        title: (page.saved ?? page.draft)?.title || '',
        mood: (page.saved ?? page.draft)?.mood ?? null,
        weather: (page.saved ?? page.draft)?.weather ?? null,
        hasDraft: Boolean(page.draft),
        published: Boolean(page.saved),
        revision: page.revision,
      })),
      nextBefore: pages.length > 30 ? slice.at(-1)!.day : null,
    });
  }
  async page(userId: string, id: string, day: string) {
    await this.owned(userId, id);
    const [page] = await this.database.database
      .select()
      .from(diaryPages)
      .where(and(eq(diaryPages.notebookId, id), eq(diaryPages.day, day)));
    const photos = await this.database.database
      .select({
        id: diaryPhotos.id,
        name: diaryPhotos.name,
        mime: diaryPhotos.mime,
        size: diaryPhotos.size,
      })
      .from(diaryPhotos)
      .where(and(eq(diaryPhotos.notebookId, id), eq(diaryPhotos.day, day)));
    return ok({
      page: {
        day,
        revision: page?.revision ?? 0,
        saved: page?.saved ?? null,
        draft: page?.draft ?? null,
        photos: photos.map(photoView),
        updatedAt: page?.updatedAt.toISOString() ?? null,
      },
    });
  }
  async write(userId: string, id: string, day: string, input: DiaryWriteInput) {
    await this.database.database.transaction(async (tx) => {
      await this.owned(userId, id, tx);
      const predicate = and(eq(diaryPages.notebookId, id), eq(diaryPages.day, day));
      const [current] = await tx.select().from(diaryPages).where(predicate);
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictError('这一页在其他地方有了修改，请重新读取后再决定');
      const photos = await tx
        .select({ id: diaryPhotos.id })
        .from(diaryPhotos)
        .where(and(eq(diaryPhotos.notebookId, id), eq(diaryPhotos.day, day)));
      if (input.content.photoIds.some((photo) => !photos.some((row) => row.id === photo)))
        throw new ValidationError('有照片已不可用，请重新选择');
      const snapshot = {
        saved: input.publish ? input.content : (current?.saved ?? null),
        draft: input.publish ? null : input.content,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: new Date(),
      };
      if (current) await tx.update(diaryPages).set(snapshot).where(predicate);
      else await tx.insert(diaryPages).values({ notebookId: id, day, ...snapshot });
      await tx
        .update(diaryNotebooks)
        .set({ updatedAt: new Date() })
        .where(eq(diaryNotebooks.id, id));
    });
    return this.page(userId, id, day);
  }
  async upload(
    userId: string,
    id: string,
    day: string,
    photoId: string,
    file: { buffer: Buffer; originalname: string; size: number } | undefined,
  ) {
    if (!file || file.size <= 0 || file.size > 10 * 1024 * 1024)
      throw new ValidationError('请选择不超过 10 MB 的图片');
    const mime = photoMime(file.buffer);
    if (!mime) throw new ValidationError('只支持 JPG、PNG、WebP 和 GIF 图片');
    return this.database.database.transaction(async (tx) => {
      await this.owned(userId, id, tx);
      const [existing] = await tx.select().from(diaryPhotos).where(eq(diaryPhotos.id, photoId));
      if (existing) {
        if (existing.notebookId !== id || existing.day !== day) throw new NotFoundError();
        return ok({ photo: photoView(existing) });
      }
      const photos = await tx
        .select({ id: diaryPhotos.id })
        .from(diaryPhotos)
        .where(and(eq(diaryPhotos.notebookId, id), eq(diaryPhotos.day, day)));
      if (photos.length >= 12)
        throw new ValidationError('这一页的照片空间已满，请先移除不用的照片');
      const name = Array.from(file.originalname)
        .filter(
          (character) => character.codePointAt(0)! >= 32 && character !== '/' && character !== '\\',
        )
        .join('')
        .trim();
      const safeName = Array.from(name || '照片')
        .slice(0, 180)
        .join('');
      const [photo] = await tx
        .insert(diaryPhotos)
        .values({
          id: photoId,
          notebookId: id,
          day,
          name: safeName,
          mime,
          size: file.size,
          data: file.buffer.toString('base64'),
        })
        .returning();
      if (!photo) throw new Error('Photo insert failed');
      return ok({ photo: photoView(photo) });
    });
  }
  async photo(userId: string, id: string, photoId: string) {
    await this.owned(userId, id);
    const [photo] = await this.database.database
      .select()
      .from(diaryPhotos)
      .where(and(eq(diaryPhotos.notebookId, id), eq(diaryPhotos.id, photoId)));
    if (!photo) throw new NotFoundError();
    return new StreamableFile(Buffer.from(photo.data, 'base64'), {
      type: photo.mime,
      disposition: 'inline',
      length: photo.size,
    });
  }
  async deletePhoto(userId: string, id: string, photoId: string) {
    return this.database.database.transaction(async (tx) => {
      await this.owned(userId, id, tx);
      const [photo] = await tx
        .select({ day: diaryPhotos.day })
        .from(diaryPhotos)
        .where(and(eq(diaryPhotos.id, photoId), eq(diaryPhotos.notebookId, id)));
      if (!photo) return ok({ deleted: true });
      const [page] = await tx
        .select()
        .from(diaryPages)
        .where(and(eq(diaryPages.notebookId, id), eq(diaryPages.day, photo.day)));
      if ([...(page?.saved?.photoIds ?? []), ...(page?.draft?.photoIds ?? [])].includes(photoId))
        throw new ConflictError('这张照片仍在日记或草稿中，请先从页面移除并保存');
      await tx.delete(diaryPhotos).where(eq(diaryPhotos.id, photoId));
      return ok({ deleted: true });
    });
  }
  async remove(userId: string, id: string, expectedRevision: number, day?: string) {
    return this.database.database.transaction(async (tx) => {
      const book = await this.owned(userId, id, tx);
      if (day) {
        const predicate = and(eq(diaryPages.notebookId, id), eq(diaryPages.day, day));
        const [page] = await tx.select().from(diaryPages).where(predicate);
        if (!page) throw new NotFoundError();
        if (page.revision !== expectedRevision) throw new ConflictError('这一页已改变，请重新读取');
        await tx
          .delete(diaryPhotos)
          .where(and(eq(diaryPhotos.notebookId, id), eq(diaryPhotos.day, day)));
        await tx.delete(diaryPages).where(predicate);
      } else {
        if (book.revision !== expectedRevision) throw new ConflictError('日记本已改变，请重新读取');
        await tx.delete(diaryNotebooks).where(eq(diaryNotebooks.id, id));
      }
      await this.audit.appendRequiredWithinTransaction(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'diary_deleted',
        resourceType: 'diary_notebook',
        resourceId: id,
        idempotencyKey: 'diary-deleted:' + crypto.randomUUID(),
        safeMetadata: {},
        occurredAt: new Date(),
      });
      return ok({ deleted: true });
    });
  }
  async settings(userId: string) {
    const [row] = await this.database.database
      .select({
        displayName: personalSettings.displayName,
        biography: personalSettings.biography,
        avatarId: personalSettings.avatarId,
        cat: personalSettings.cat,
        readingSize: personalSettings.readingSize,
        bookmarks: personalSettings.bookmarks,
        revision: personalSettings.revision,
      })
      .from(personalSettings)
      .where(eq(personalSettings.userId, userId));
    return ok({
      settings: row
        ? {
            displayName: row.displayName,
            biography: row.biography,
            avatarId: row.avatarId,
            cat: row.cat,
            readingSize: row.readingSize,
            bookmarks: row.bookmarks,
            revision: row.revision,
          }
        : {
            displayName: '',
            biography: '',
            avatarId: null,
            cat: 'relaxed',
            readingSize: 18,
            bookmarks: [],
            revision: 0,
          },
    });
  }
  async updateSettings(
    userId: string,
    input: SettingsWriteInput,
    file?: { buffer: Buffer; size: number },
  ) {
    // Normalize before holding the account lock. No image bytes are returned in settings JSON.
    const image = file ? await normalizeAvatar(file) : null;
    await this.database.database.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [row] = await tx
        .select()
        .from(personalSettings)
        .where(eq(personalSettings.userId, userId));
      if ((row?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictError('个人设置已改变，请重新读取后再保存');
      if (input.avatarId && input.avatarId !== row?.avatarId) throw new NotFoundError('头像不存在');
      const values = {
        displayName: input.displayName,
        biography: input.biography ?? row?.biography ?? '',
        avatarId: image
          ? crypto.randomUUID()
          : input.avatarId === null
            ? null
            : (row?.avatarId ?? null),
        avatarData: image
          ? image.toString('base64')
          : input.avatarId === null
            ? null
            : (row?.avatarData ?? null),
        cat: input.cat,
        readingSize: input.readingSize,
        bookmarks: input.bookmarks,
        revision: (row?.revision ?? 0) + 1,
      };
      if (row)
        await tx.update(personalSettings).set(values).where(eq(personalSettings.userId, userId));
      else await tx.insert(personalSettings).values({ userId, ...values });
    });
    return this.settings(userId);
  }
  async avatar(userId: string, avatarId: string) {
    const [row] = await this.database.database
      .select({ data: personalSettings.avatarData })
      .from(personalSettings)
      .where(and(eq(personalSettings.userId, userId), eq(personalSettings.avatarId, avatarId)));
    if (!row?.data) throw new NotFoundError('头像不存在');
    const bytes = Buffer.from(row.data, 'base64');
    return new StreamableFile(bytes, {
      type: 'image/webp',
      disposition: 'inline',
      length: bytes.length,
    });
  }
}
