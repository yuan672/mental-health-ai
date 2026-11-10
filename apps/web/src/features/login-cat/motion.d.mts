export type CatState = 'rest' | 'peek' | 'caught' | 'sleep';
export type CatPose = {
  awake: number;
  angle: number;
  x: number;
  gazeX: number;
  gazeY: number;
  lids: number;
  y: number;
  frontY: number;
  frontScale: number;
  breathe: number;
  ear: number;
  time: number;
  state: CatState;
  target: { x: number; y: number };
  fieldAngle: number;
};
export function createLoginCatMotion(): {
  step: (ms: number) => CatPose;
  setState: (state: CatState) => void;
  lookAt: (point: { x: number; y: number }) => void;
  nudge: () => void;
  setReduced: (value: boolean) => void;
  readonly state: CatState;
};
