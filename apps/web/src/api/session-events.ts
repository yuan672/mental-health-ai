type SessionInvalidatedListener = () => void;

const listeners = new Set<SessionInvalidatedListener>();

export function subscribeSessionInvalidated(listener: SessionInvalidatedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySessionInvalidated(): void {
  for (const listener of listeners) listener();
}
