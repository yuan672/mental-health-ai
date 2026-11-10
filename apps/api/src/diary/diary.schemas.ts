import type { DiaryCat, DiaryWeather } from '@mental-health/types';
import { z } from 'zod';

// The types workspace is type-only in the CommonJS API runtime, like Mood schemas.
const DIARY_CAT_VALUES = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'sleepy',
  'hopeful',
  'relaxed',
] as const satisfies readonly DiaryCat[];
const DIARY_WEATHER_VALUES = [
  'sun',
  'cloud',
  'partly-cloudy',
  'rain',
  'drizzle',
  'storm',
  'snow',
  'wind',
  'fog',
] as const satisfies readonly DiaryWeather[];

const bounded = (max: number) =>
  z
    .string()
    .trim()
    .refine((value) => Array.from(value).length <= max, `最多 ${max} 个字`);
export const diaryContentSchema = z
  .object({
    title: bounded(80),
    body: bounded(10000),
    mood: z.enum(DIARY_CAT_VALUES).nullable(),
    weather: z.enum(DIARY_WEATHER_VALUES).nullable(),
    photoIds: z
      .array(z.uuid())
      .max(6)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const notebookCreateSchema = z
  .object({
    id: z.uuid(),
    name: bounded(24).refine((value) => value.length > 0),
    cat: z.enum(DIARY_CAT_VALUES),
  })
  .strict();
export const revisionSchema = z.object({ expectedRevision: z.int().min(0) }).strict();
export const notebookUpdateSchema = notebookCreateSchema
  .omit({ id: true })
  .extend({ expectedRevision: z.int().positive() })
  .strict();
export const notebookParamsSchema = z.object({ bookId: z.uuid() }).strict();
const validDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((day) => {
    const date = new Date(day + 'T12:00:00Z');
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === day &&
      day >= '1900-01-01' &&
      day <=
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date())
    );
  }, '日记日期无效或在未来');
export const pageParamsSchema = notebookParamsSchema.extend({ day: validDay }).strict();
export const photoParamsSchema = notebookParamsSchema.extend({ photoId: z.uuid() }).strict();
export const pageWriteSchema = z
  .object({ expectedRevision: z.int().min(0), content: diaryContentSchema, publish: z.boolean() })
  .strict()
  .refine(
    (value) =>
      !value.publish ||
      Boolean(
        value.content.mood &&
        value.content.weather &&
        (value.content.body.trim() || value.content.photoIds.length),
      ),
    { message: '请选好心情和天气，再留下一段文字或一张照片' },
  );
export const photoUploadSchema = z.object({ photoId: z.uuid() }).strict();
export const pageListSchema = z.object({ before: validDay.optional() }).strict();
export const settingsUpdateSchema = z
  .object({
    expectedRevision: z.int().min(0),
    displayName: bounded(24),
    biography: bounded(200).optional(),
    avatarId: z.uuid().nullable().optional(),
    cat: z.enum(DIARY_CAT_VALUES),
    readingSize: z.union([z.literal(16), z.literal(18), z.literal(20)]),
    bookmarks: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/u))
      .max(100)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type DiaryWriteInput = z.infer<typeof pageWriteSchema>;
export type SettingsWriteInput = z.infer<typeof settingsUpdateSchema>;
export const avatarParamsSchema = z.object({ avatarId: z.uuid() }).strict();
export const settingsMultipartSchema = z
  .object({
    settings: z
      .string()
      .transform((value, context) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          context.addIssue({ code: 'custom', message: '个人设置格式无效' });
          return z.NEVER;
        }
      })
      .pipe(settingsUpdateSchema),
  })
  .strict();

export function photoMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
