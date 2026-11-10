const SENTENCE_BOUNDARY = /[。！？!?；;\n]/u;

function characterLength(value: string): number {
  return Array.from(value).length;
}

function takeCharacters(value: string, count: number): { segment: string; remainder: string } {
  const characters = Array.from(value);
  return {
    segment: characters.slice(0, count).join(''),
    remainder: characters.slice(count).join(''),
  };
}

export class SentenceSegmentBuffer {
  private bufferedAt: number | null = null;
  private value = '';
  private emitted = false;

  constructor(
    private readonly hardCharacterCap: number,
    private readonly maxWaitMilliseconds: number,
    private readonly batch?: Readonly<{ firstMinimum: number; nextMinimum: number }>,
  ) {}

  append(delta: string, now = Date.now()): string[] {
    if (delta.length === 0) {
      return [];
    }
    if (this.value.length === 0) {
      this.bufferedAt = now;
    }
    this.value += delta;

    const ready: string[] = [];
    while (this.value.length > 0) {
      const characters = Array.from(this.value);
      const minimum = Math.min(
        this.hardCharacterCap,
        this.batch ? (this.emitted ? this.batch.nextMinimum : this.batch.firstMinimum) : 1,
      );
      let end = 0;
      let lastBoundary = 0;
      // Keep sentence boundaries, but combine tiny sentences/blank lines into
      // one bounded safety candidate. Never let a late boundary exceed the cap.
      for (let index = 0; index < Math.min(characters.length, this.hardCharacterCap); index += 1) {
        if (SENTENCE_BOUNDARY.test(characters[index]!)) {
          lastBoundary = index + 1;
          if (lastBoundary >= minimum) {
            end = lastBoundary;
            break;
          }
        }
      }
      if (!end && characterLength(this.value) >= this.hardCharacterCap) {
        end = lastBoundary || this.hardCharacterCap;
      }
      if (end) {
        const split = takeCharacters(this.value, end);
        ready.push(split.segment);
        this.emitted = true;
        this.value = split.remainder;
        this.bufferedAt = this.value.length > 0 ? now : null;
        continue;
      }
      break;
    }
    return ready;
  }

  flushIfDue(now = Date.now()): string | null {
    if (
      this.bufferedAt === null ||
      now - this.bufferedAt < this.maxWaitMilliseconds ||
      this.value.length === 0
    ) {
      return null;
    }
    return this.flush();
  }

  flush(): string | null {
    if (this.value.length === 0) {
      return null;
    }
    const segment = this.value;
    this.emitted = true;
    this.value = '';
    this.bufferedAt = null;
    return segment;
  }

  millisecondsUntilFlush(now = Date.now()): number | null {
    if (this.bufferedAt === null || this.value.length === 0) {
      return null;
    }
    return Math.max(0, this.maxWaitMilliseconds - (now - this.bufferedAt));
  }

  clear(): void {
    this.value = '';
    this.bufferedAt = null;
  }
}
