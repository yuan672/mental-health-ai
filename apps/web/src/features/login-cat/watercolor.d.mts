import type { CatPose } from './motion.mjs';
export function createLoginCatWatercolorRenderer(
  canvas: HTMLCanvasElement,
  images: { open: HTMLImageElement; closed: HTMLImageElement },
): { mode: string; draw: (pose: CatPose) => void; dispose: () => void } | null;
