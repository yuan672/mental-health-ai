import type { ApiSuccessResponse } from './index.js';

export type MoodCat =
  'happy' | 'sad' | 'angry' | 'surprised' | 'shy' | 'sleepy' | 'hopeful' | 'relaxed';

export const MOOD_EMOTION_VALUES = [
  'joyful',
  'calm',
  'hopeful',
  'neutral',
  'tired',
  'stressed',
  'sad',
  'angry',
  'overwhelmed',
] as const;

export type MoodEmotion = (typeof MOOD_EMOTION_VALUES)[number];

export type MoodEntry = {
  id: string;
  moodScore: number | null;
  catMood?: MoodCat | null | undefined;
  emotion: MoodEmotion | null;
  note: string | null;
  stateRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateMoodEntryRequest = {
  clientRequestId: string;
  moodScore?: number | null;
  catMood?: MoodCat | null | undefined;
  emotion?: MoodEmotion | null;
  note?: string | null;
};

export type NormalizedCreateMoodEntryRequest = CreateMoodEntryRequest;

export type UpdateMoodEntryRequest = {
  expectedRevision: number;
  moodScore?: number | null;
  catMood?: MoodCat | null | undefined;
  emotion: MoodEmotion | null;
  note: string | null;
};

export type NormalizedUpdateMoodEntryRequest = UpdateMoodEntryRequest;
export type DeleteMoodEntryRequest = { expectedRevision: number };

export type CreateMoodEntryResponse = ApiSuccessResponse<{
  entry: MoodEntry;
  disposition: 'created' | 'existing';
}>;
export type MoodEntryResponse = ApiSuccessResponse<{ entry: MoodEntry }>;
export type MoodCreationStatusResponse = ApiSuccessResponse<
  { status: 'present'; entry: MoodEntry } | { status: 'absent' }
>;
export type MoodDailyTrend = {
  localDate: string;
  entryCount: number;
  averageMoodScore: number | null;
  latestEntry?: Pick<MoodEntry, 'catMood' | 'moodScore' | 'emotion'> | undefined;
};
export type MoodHistoryResponse = ApiSuccessResponse<{
  days: 7 | 30;
  timeZone: 'Asia/Shanghai';
  period: { startDate: string; endDate: string };
  entries: MoodEntry[];
  dailyTrend: MoodDailyTrend[];
  nextCursor: string | null;
}>;
export type DeleteMoodEntryResponse = ApiSuccessResponse<{ deleted: true }>;
export type DeleteMoodHistoryResponse = ApiSuccessResponse<{
  deleted: true;
  entryCount: number;
}>;
export type ProfileResponse = ApiSuccessResponse<{
  email: string;
  accountCreatedAt: string;
  adultEligibility: { verified: true; verifiedAt: string };
}>;
