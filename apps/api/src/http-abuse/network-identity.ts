import { isIP } from 'node:net';
import type { Request } from 'express';

const UNKNOWN_NETWORK_IDENTITY = 'unknown-direct-peer';

export function directNetworkIdentity(request: Pick<Request, 'socket'>): string {
  const address = request.socket.remoteAddress?.trim().toLowerCase();
  if (!address) return UNKNOWN_NETWORK_IDENTITY;
  const withoutZone = address.split('%', 1)[0] ?? '';
  const family = isIP(withoutZone);
  if (family === 0) return UNKNOWN_NETWORK_IDENTITY;
  if (family === 4) return withoutZone;

  // WHATWG URL parsing gives equivalent IPv6 spellings one canonical compressed
  // representation. The value is already validated as an IPv6 literal, so this
  // cannot turn an arbitrary string into a limiter key.
  const canonical = new URL(`http://[${withoutZone}]/`).hostname;
  const normalized = canonical.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
  if (!mapped) return normalized;
  const upper = Number.parseInt(mapped[1] as string, 16);
  const lower = Number.parseInt(mapped[2] as string, 16);
  return `${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`;
}
