import type { DiaryCat } from '@mental-health/types';
import { useState } from 'react';
import { diaryApi } from '../api/diary';
import { CatArt } from './cat-art';

export function ProfileAvatar({
  cat,
  avatarId,
  preview,
  name = '我的头像',
}: {
  cat: DiaryCat;
  avatarId: string | null;
  preview?: string | null;
  name?: string;
}) {
  const source = preview || (avatarId ? diaryApi.avatarUrl(avatarId) : null);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="profile-avatar" role="img" aria-label={name}>
      {source && source !== failed ? (
        <img src={source} alt="" onError={() => setFailed(source)} />
      ) : (
        <CatArt mood={cat} />
      )}
    </span>
  );
}
