export function safeOperationalPath(url: string | undefined): string {
  const pathname = (url ?? '').split('?', 1)[0] ?? '';
  const aiTurnMetadataMatch = pathname.match(/^\/+admin\/+ai-quality\/+turns(?:(\/+)(.*))?$/iu);
  if (aiTurnMetadataMatch) {
    return aiTurnMetadataMatch[2] ? '/admin/ai-quality/turns/:turnId' : '/admin/ai-quality/turns';
  }
  return pathname
    .replace(/^\/incognito-contexts\/[^/]+(?=\/|$)/u, '/incognito-contexts/:contextId')
    .replace(/^\/admin\/staff-principals\/[^/]+(?=\/|$)/u, '/admin/staff-principals/:id');
}
