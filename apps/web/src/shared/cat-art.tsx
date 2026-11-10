import { useId, type CSSProperties } from 'react';
import type { DiaryCat, DiaryWeather } from '@mental-health/types';
import sprite from '../assets/cozy/cat-emotions-reference.png';
export { default as brandCat } from '../assets/cozy/cat-brand.png';
export { default as homeCat } from '../assets/cozy/cat-living-room.png';
export { default as diaryCat } from '../assets/cozy/cat-diary-corner.png';

export const cats: Record<
  DiaryCat,
  { label: string; crop: readonly [number, number, number, number] }
> = {
  happy: { label: '开心', crop: [26, 58, 350, 386] },
  sad: { label: '委屈', crop: [407, 111, 291, 333] },
  angry: { label: '生气', crop: [723, 91, 367, 352] },
  surprised: { label: '惊讶', crop: [1138, 106, 375, 337] },
  shy: { label: '害羞', crop: [45, 528, 305, 374] },
  sleepy: { label: '困倦', crop: [377, 573, 359, 314] },
  hopeful: { label: '期待', crop: [759, 532, 314, 366] },
  relaxed: { label: '放松', crop: [1072, 595, 437, 308] },
};
export function CatArt({
  mood = 'relaxed',
  className = '',
}: {
  mood?: DiaryCat;
  className?: string;
}) {
  const clipId = useId();
  const [x, y, w, h] = cats[mood].crop;
  return (
    <span
      aria-hidden="true"
      className={`cat-art cat-${mood} ${className}`}
      style={{ '--cat-ratio': `${w}/${h}` } as CSSProperties}
    >
      <svg viewBox={`${x} ${y} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" focusable="false">
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <rect x={x} y={y} width={w} height={h} />
          </clipPath>
        </defs>
        {/* Clip the source too: differently shaped cards can leave space outside the viewBox. */}
        <image href={sprite} width="1536" height="1024" clipPath={`url(#${clipId})`} />
      </svg>
    </span>
  );
}
const weatherFiles = import.meta.glob('../assets/cozy/weather/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
export const weathers: Record<DiaryWeather, { label: string; file: string }> = {
  sun: { label: '晴天', file: 'clear-day' },
  cloud: { label: '阴天', file: 'overcast' },
  'partly-cloudy': { label: '多云', file: 'partly-cloudy-day' },
  rain: { label: '下雨', file: 'rain' },
  drizzle: { label: '小雨', file: 'drizzle' },
  storm: { label: '雷雨', file: 'thunderstorms-rain' },
  snow: { label: '下雪', file: 'snow' },
  wind: { label: '有风', file: 'wind' },
  fog: { label: '起雾', file: 'fog' },
};
export function WeatherArt({ weather }: { weather: DiaryWeather }) {
  const name = weathers[weather].file;
  return (
    <span className="weather-art" aria-hidden="true">
      <img
        className="weather-still"
        src={weatherFiles[`../assets/cozy/weather/${name}--static.svg`]}
        alt=""
      />
      <img
        className="weather-moving"
        src={weatherFiles[`../assets/cozy/weather/${name}--animated.svg`]}
        alt=""
      />
    </span>
  );
}
