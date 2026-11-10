import {
  DIARY_CAT_VALUES,
  DIARY_WEATHER_VALUES,
  type DiaryCat,
  type DiaryContent,
  type PersonalSettings,
} from '@mental-health/types';
import { z } from 'zod';
import { apiRequest } from './client';
import { publicEnv } from '../config/env';

const cat = z.enum(DIARY_CAT_VALUES);
const weather = z.enum(DIARY_WEATHER_VALUES);
const content = z
  .object({
    title: z.string(),
    body: z.string(),
    mood: cat.nullable(),
    weather: weather.nullable(),
    photoIds: z.array(z.string().uuid()),
  })
  .strict();
const photo = z
  .object({ id: z.string().uuid(), name: z.string(), mime: z.string(), size: z.number() })
  .strict();
const book = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    cat,
    revision: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const page = z
  .object({
    day: z.string(),
    revision: z.number(),
    saved: content.nullable(),
    draft: content.nullable(),
    photos: z.array(photo),
    updatedAt: z.string().nullable(),
  })
  .strict();
const entry = z
  .object({
    day: z.string(),
    title: z.string(),
    mood: cat.nullable(),
    weather: weather.nullable(),
    hasDraft: z.boolean(),
    published: z.boolean(),
    revision: z.number(),
  })
  .strict();
const settings = z
  .object({
    displayName: z.string(),
    biography: z.string().default(''),
    avatarId: z.string().uuid().nullable().default(null),
    cat,
    readingSize: z.union([z.literal(16), z.literal(18), z.literal(20)]),
    bookmarks: z.array(z.string()),
    revision: z.number(),
  })
  .strict();
const response = <T extends z.ZodType>(data: T) =>
  z.object({ success: z.literal(true), data }).strict();
const root = '/diary/notebooks';
const pagePath = (id: string, day: string) =>
  `${root}/${encodeURIComponent(id)}/entries/${encodeURIComponent(day)}`;
const mutation = (body: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') =>
  ({ body, method, csrf: true }) as const;
export const diaryApi = {
  list: (signal?: AbortSignal) =>
    apiRequest(root, response(z.object({ books: z.array(book) })), signal ? { signal } : {}),
  create: (input: { id: string; name: string; cat: DiaryCat }) =>
    apiRequest(root, response(z.object({ book })), mutation(input)),
  rename: (id: string, input: { name: string; cat: DiaryCat; expectedRevision: number }) =>
    apiRequest(`${root}/${id}`, response(z.object({ book })), mutation(input, 'PATCH')),
  entries: (id: string, before?: string, signal?: AbortSignal) =>
    apiRequest(
      `${root}/${id}${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      response(z.object({ book, entries: z.array(entry), nextBefore: z.string().nullable() })),
      signal ? { signal } : {},
    ),
  page: (id: string, day: string, signal?: AbortSignal) =>
    apiRequest(pagePath(id, day), response(z.object({ page })), signal ? { signal } : {}),
  save: (
    id: string,
    day: string,
    input: { expectedRevision: number; content: DiaryContent; publish: boolean },
  ) => apiRequest(pagePath(id, day), response(z.object({ page })), mutation(input)),
  remove: (id: string, expectedRevision: number, day?: string) =>
    apiRequest(
      day ? pagePath(id, day) : `${root}/${id}`,
      response(z.object({ deleted: z.boolean() })),
      mutation({ expectedRevision }, 'DELETE'),
    ),
  upload: (id: string, day: string, file: File, photoId: string) => {
    const form = new FormData();
    form.append('photoId', photoId);
    form.append('image', file);
    return apiRequest(`${pagePath(id, day)}/photos`, response(z.object({ photo })), mutation(form));
  },
  removePhoto: (id: string, photoId: string) =>
    apiRequest(
      `${root}/${id}/photos/${photoId}`,
      response(z.object({ deleted: z.boolean() })),
      mutation(undefined, 'DELETE'),
    ),
  photoUrl: (id: string, photoId: string) =>
    new URL(`${root}/${id}/photos/${photoId}`, publicEnv.VITE_API_BASE_URL).href,
  settings: (signal?: AbortSignal) =>
    apiRequest('/profile/settings', response(z.object({ settings })), signal ? { signal } : {}),
  updateSettings: (
    input: Omit<PersonalSettings, 'revision'> & { expectedRevision: number },
    file?: File,
  ) => {
    if (!file)
      return apiRequest(
        '/profile/settings',
        response(z.object({ settings })),
        mutation(input, 'PATCH'),
      );
    const form = new FormData();
    form.append('settings', JSON.stringify(input));
    form.append('image', file);
    return apiRequest('/profile/settings', response(z.object({ settings })), mutation(form));
  },
  avatarUrl: (id: string) =>
    new URL(`/profile/settings/avatar/${encodeURIComponent(id)}`, publicEnv.VITE_API_BASE_URL).href,
};
