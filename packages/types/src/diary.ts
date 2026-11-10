export const DIARY_CAT_VALUES = [
  'happy',
  'sad',
  'angry',
  'surprised',
  'shy',
  'sleepy',
  'hopeful',
  'relaxed',
] as const;
export const DIARY_WEATHER_VALUES = [
  'sun',
  'cloud',
  'partly-cloudy',
  'rain',
  'drizzle',
  'storm',
  'snow',
  'wind',
  'fog',
] as const;
export type DiaryCat = (typeof DIARY_CAT_VALUES)[number];
export type DiaryWeather = (typeof DIARY_WEATHER_VALUES)[number];
export type DiaryContent = {
  title: string;
  body: string;
  mood: DiaryCat | null;
  weather: DiaryWeather | null;
  photoIds: string[];
};
export type DiaryPhoto = { id: string; name: string; mime: string; size: number };
export type DiaryPage = {
  day: string;
  revision: number;
  saved: DiaryContent | null;
  draft: DiaryContent | null;
  photos: DiaryPhoto[];
  updatedAt: string | null;
};
export type DiaryNotebook = {
  id: string;
  name: string;
  cat: DiaryCat;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type DiaryEntrySummary = {
  day: string;
  title: string;
  mood: DiaryCat | null;
  weather: DiaryWeather | null;
  hasDraft: boolean;
  published: boolean;
  revision: number;
};
export type PersonalSettings = {
  displayName: string;
  biography: string;
  avatarId: string | null;
  cat: DiaryCat;
  readingSize: 16 | 18 | 20;
  bookmarks: string[];
  revision: number;
};
