import catAngry from '../assets/cat-angry.png';
import catHappy from '../assets/cat-happy.png';
import catHopeful from '../assets/cat-hopeful.png';
import catRelaxed from '../assets/cat-relaxed.png';
import catSad from '../assets/cat-sad.png';
import catShy from '../assets/cat-shy.png';
import catSleepy from '../assets/cat-sleepy.png';
import catSurprised from '../assets/cat-surprised.png';

export type CatMood =
  'happy' | 'sad' | 'angry' | 'surprised' | 'shy' | 'sleepy' | 'hopeful' | 'relaxed';

const artByMood: Record<CatMood, string> = {
  happy: catHappy,
  sad: catSad,
  angry: catAngry,
  surprised: catSurprised,
  shy: catShy,
  sleepy: catSleepy,
  hopeful: catHopeful,
  relaxed: catRelaxed,
};

export function CatArt({
  mood,
  className = '',
  alt = '',
}: {
  mood: CatMood;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      className={`cat-art ${className}`.trim()}
      data-cat-mood={mood}
      src={artByMood[mood]}
      alt={alt}
      aria-hidden={alt ? undefined : 'true'}
    />
  );
}
