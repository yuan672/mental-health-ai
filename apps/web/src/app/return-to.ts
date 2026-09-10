const DEFAULT_RETURN_TO = '/app/chat';

export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return DEFAULT_RETURN_TO;
  let candidate = value;
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return DEFAULT_RETURN_TO;
  }
  try {
    const parsed = new URL(candidate, 'https://local.invalid');
    if (parsed.origin !== 'https://local.invalid' || !parsed.pathname.startsWith('/app')) {
      return DEFAULT_RETURN_TO;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}
