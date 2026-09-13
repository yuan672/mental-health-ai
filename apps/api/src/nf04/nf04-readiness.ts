export type Nf04ReadinessInput = Readonly<{
  timeoutMs: number;
  retryIntervalMs: number;
  probe: () => Promise<boolean>;
}>;

export class Nf04ReadinessDeadlineError extends Error {
  constructor() {
    super('NF-04 readiness deadline expired');
    this.name = Nf04ReadinessDeadlineError.name;
  }
}

/**
 * A readiness retry is part of the foreground drill lifecycle. Its timer stays
 * referenced so the CLI cannot exit while the awaited operation is unresolved.
 */
export async function waitForNf04Readiness(input: Nf04ReadinessInput): Promise<void> {
  assertPositiveDuration(input.timeoutMs);
  assertPositiveDuration(input.retryIntervalMs);
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    if (await input.probe()) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await waitForNf04ReadinessInterval(Math.min(input.retryIntervalMs, remainingMs));
  }

  throw new Nf04ReadinessDeadlineError();
}

export function waitForNf04ReadinessInterval(milliseconds: number): Promise<void> {
  assertPositiveDuration(milliseconds);
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function assertPositiveDuration(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error('NF-04 readiness duration must be positive');
  }
}
