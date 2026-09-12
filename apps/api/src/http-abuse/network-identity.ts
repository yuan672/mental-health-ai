import { isIP } from 'node:net';
import type { Request } from 'express';

const UNKNOWN_NETWORK_IDENTITY = 'unknown-direct-peer';

export function directNetworkIdentity(request: Pick<Request, 'socket'>): string {
  const address = request.socket.remoteAddress?.trim().toLowerCase();
  if (!address) return UNKNOWN_NETWORK_IDENTITY;
  const withoutMappedPrefix = address.startsWith('::ffff:') ? address.slice(7) : address;
  const withoutZone = withoutMappedPrefix.split('%', 1)[0] ?? '';
  const family = isIP(withoutZone);
  if (family === 0) return UNKNOWN_NETWORK_IDENTITY;
  if (family === 4) return withoutZone;

  // WHATWG URL parsing gives equivalent IPv6 spellings one canonical compressed
  // representation. The value is already validated as an IPv6 literal, so this
  // cannot turn an arbitrary string into a limiter key.
  const canonical = new URL(`http://[${withoutZone}]/`).hostname;
  return canonical.slice(1, -1);
}
