export function safeOperationalPath(url: string | undefined): string {
  const pathname = (url ?? '').split('?', 1)[0] ?? '';
  const aiTurnMetadataMatch = pathname.match(/^\/+admin\/+ai-quality\/+turns(?:(\/+)(.*))?$/iu);
  if (aiTurnMetadataMatch) {
    return aiTurnMetadataMatch[2] ? '/admin/ai-quality/turns/:turnId' : '/admin/ai-quality/turns';
  }
  return pathname
    .replace(/^\/diary\/ai\/turns\/[^/]+(?=\/|$)/u, '/diary/ai/turns/:turnId')
    .replace(/^\/profile\/settings\/avatar\/[^/]+(?=\/|$)/u, '/profile/settings/avatar/:avatarId')
    .replace(/^\/diary\/notebooks\/[^/]+(?=\/|$)/u, '/diary/notebooks/:bookId')
    .replace(/^(\/diary\/notebooks\/:bookId\/entries)\/[^/]+(?=\/|$)/u, '$1/:day')
    .replace(/^(\/diary\/notebooks\/:bookId\/photos)\/[^/]+(?=\/|$)/u, '$1/:photoId')
    .replace(/^\/incognito-contexts\/[^/]+(?=\/|$)/u, '/incognito-contexts/:contextId')
    .replace(/^\/admin\/staff-principals\/[^/]+(?=\/|$)/u, '/admin/staff-principals/:id');
}
