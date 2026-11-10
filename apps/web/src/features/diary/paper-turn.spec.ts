import { describe, expect, it } from 'vitest';
import {
  paperGeometry,
  paperMatrix,
  paperShade,
  paperStripCount,
  stablePaperMatrix,
} from './paper-turn';

describe('approved soft-paper projection (no rendered UI)', () => {
  it('keeps depth ordered at the reduced strip density so stacking can remain static', () => {
    for (const direction of ['forward', 'back'] as const) {
      for (const [width, height] of [
        [480, 740],
        [640, 900],
        [1100, 2500],
      ]) {
        const count = paperStripCount(width!, height!);
        expect(count).toBeLessThanOrEqual(40);
        for (let frame = 0; frame <= 120; frame++) {
          const parts = paperGeometry(width!, height!, count, frame / 120, direction, width!);
          parts.forEach((part, i) => {
            if (i) expect(part.depth).toBeGreaterThanOrEqual(parts[i - 1]!.depth - 1e-8);
          });
        }
      }
    }
  });
  it.each(['forward', 'back'] as const)(
    'shares every patch edge and keeps the spine fixed (%s)',
    (direction) => {
      for (const progress of [0, 0.2, 0.49, 0.51, 0.8, 1]) {
        const parts = paperGeometry(500, 740, 50, progress, direction, 500, 7);
        parts.forEach((part, i) => {
          const next = parts[i + 1];
          if (next) {
            const front = direction === 'forward';
            expect(part.points[front ? 1 : 0]).toEqual(next.points[front ? 0 : 1]);
            expect(part.points[front ? 2 : 3]).toEqual(next.points[front ? 3 : 2]);
          }
        });
        const hinge = parts[0]?.points[direction === 'forward' ? 0 : 1];
        expect(hinge?.x).toBeCloseTo(500);
        expect(hinge?.y).toBeCloseTo(7);
      }
    },
  );
  it('turns the source side into the reverse side without changing paper width', () => {
    const start = paperGeometry(500, 740, 50, 0, 'forward', 500);
    const end = paperGeometry(500, 740, 50, 1, 'forward', 500);
    expect(start.every((part) => !part.back)).toBe(true);
    expect(end.every((part) => part.back)).toBe(true);
    expect(start.at(-1)?.points[1].x).toBeCloseTo(1000);
    expect(end.at(-1)?.points[1].x).toBeCloseTo(0);
  });
  it('projects the rectangle corners onto each safe curved patch', () => {
    for (const progress of [0, 0.25, 0.4, 0.65, 0.9, 1]) {
      for (const part of paperGeometry(500, 740, 50, progress, 'back', 500, 7)) {
        const m = paperMatrix(part.points, 10, 740);
        if (!stablePaperMatrix(m, 10, 740)) continue;
        [
          [0, 0],
          [10, 0],
          [10, 740],
          [0, 740],
        ].forEach(([x = 0, y = 0], i) => {
          const denominator = m[3]! * x + m[7]! * y + 1;
          expect((m[0]! * x + m[4]! * y + m[12]!) / denominator).toBeCloseTo(part.points[i]!.x, 5);
          expect((m[1]! * x + m[5]! * y + m[13]!) / denominator).toBeCloseTo(part.points[i]!.y, 5);
        });
      }
    }
  });
  it('rejects projective poles that could stretch a crease over the viewport', () => {
    const matrix = paperMatrix(
      [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 740, z: 0 },
        { x: 0, y: 740, z: 0 },
      ],
      10,
      740,
    );
    expect(stablePaperMatrix(matrix, 10, 740)).toBe(true);
    matrix[3] = -0.2;
    expect(stablePaperMatrix(matrix, 10, 740)).toBe(false);
  });
  it('uses one gentle light field instead of a repeated dark gradient on each strip', () => {
    for (let i = 0; i <= 50; i++) {
      const light = paperShade(0.5, i / 50);
      expect(light).toBeLessThanOrEqual(0.05);
      expect(light).toBeGreaterThanOrEqual(0);
      if (i) expect(Math.abs(light - paperShade(0.5, (i - 1) / 50))).toBeLessThan(0.003);
    }
  });
});
