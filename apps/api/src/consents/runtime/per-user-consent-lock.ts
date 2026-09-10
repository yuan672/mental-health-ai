import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../../config/env';

export class ConsentCoordinationCapacityError extends Error {
  constructor(
    public readonly reason: 'global_waiter_limit' | 'user_waiter_limit' | 'revoked_marker_limit',
  ) {
    super(`Consent coordination capacity reached: ${reason}`);
    this.name = ConsentCoordinationCapacityError.name;
  }
}

type Release = () => void;
type Waiter = {
  signal: AbortSignal;
  resolve: (release: Release) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
  timer: NodeJS.Timeout;
};
type LockState = { held: boolean; waiters: Waiter[] };

@Injectable()
export class PerUserConsentLock implements OnModuleDestroy {
  private readonly locks = new Map<string, LockState>();
  private waiterCount = 0;
  private destroyed = false;

  async runExclusive<T>(
    userId: string,
    signal: AbortSignal,
    deadlineAt: Date,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(userId, signal, deadlineAt);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  diagnostics(): Readonly<{ users: number; waiters: number }> {
    return { users: this.locks.size, waiters: this.waiterCount };
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const [userId, state] of this.locks) {
      for (const waiter of [...state.waiters]) {
        this.removeWaiter(userId, state, waiter);
        waiter.reject(new Error('application_shutdown'));
      }
      if (!state.held) this.locks.delete(userId);
    }
  }

  private acquire(userId: string, signal: AbortSignal, deadlineAt: Date): Promise<Release> {
    if (this.destroyed) return Promise.reject(new Error('application_shutdown'));
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('consent_lock_aborted'));
    const remaining = deadlineAt.getTime() - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('consent_lock_deadline_exceeded'));

    const state = this.locks.get(userId) ?? { held: false, waiters: [] };
    this.locks.set(userId, state);
    if (!state.held) {
      state.held = true;
      return Promise.resolve(this.releaseFor(userId, state));
    }
    if (this.waiterCount >= env.CONSENT_LOCK_MAX_WAITERS_GLOBAL) {
      return Promise.reject(new ConsentCoordinationCapacityError('global_waiter_limit'));
    }
    if (state.waiters.length >= env.CONSENT_LOCK_MAX_WAITERS_PER_USER) {
      return Promise.reject(new ConsentCoordinationCapacityError('user_waiter_limit'));
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter = {} as Waiter;
      waiter.signal = signal;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.onAbort = () => {
        if (!this.removeWaiter(userId, state, waiter)) return;
        reject(signal.reason ?? new Error('consent_lock_aborted'));
      };
      waiter.timer = setTimeout(() => {
        if (!this.removeWaiter(userId, state, waiter)) return;
        reject(new Error('consent_lock_deadline_exceeded'));
      }, remaining);
      waiter.timer.unref();
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      state.waiters.push(waiter);
      this.waiterCount += 1;
    });
  }

  private releaseFor(userId: string, state: LockState): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) {
        this.waiterCount -= 1;
        this.cleanupWaiter(next);
        next.resolve(this.releaseFor(userId, state));
        return;
      }
      state.held = false;
      if (this.locks.get(userId) === state) this.locks.delete(userId);
    };
  }

  private removeWaiter(userId: string, state: LockState, waiter: Waiter): boolean {
    const index = state.waiters.indexOf(waiter);
    if (index < 0) return false;
    state.waiters.splice(index, 1);
    this.waiterCount -= 1;
    this.cleanupWaiter(waiter);
    if (!state.held && state.waiters.length === 0 && this.locks.get(userId) === state) {
      this.locks.delete(userId);
    }
    return true;
  }

  private cleanupWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}
