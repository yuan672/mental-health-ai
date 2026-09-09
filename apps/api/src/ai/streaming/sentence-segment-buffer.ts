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

  constructor(
    private readonly hardCharacterCap: number,
    private readonly maxWaitMilliseconds: number,
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
      const boundary = this.value.search(SENTENCE_BOUNDARY);
      if (boundary >= 0) {
        const end = boundary + 1;
        ready.push(this.value.slice(0, end));
        this.value = this.value.slice(end);
        this.bufferedAt = this.value.length > 0 ? now : null;
        continue;
      }
      if (characterLength(this.value) >= this.hardCharacterCap) {
        const split = takeCharacters(this.value, this.hardCharacterCap);
        ready.push(split.segment);
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
