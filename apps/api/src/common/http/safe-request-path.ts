export function safeOperationalPath(url: string | undefined): string {
  const pathname = (url ?? '').split('?', 1)[0] ?? '';
  return pathname
    .replace(/^\/incognito-contexts\/[^/]+(?=\/|$)/u, '/incognito-contexts/:contextId')
    .replace(/^\/admin\/staff-principals\/[^/]+(?=\/|$)/u, '/admin/staff-principals/:id');
}
