export function createLoginCatMotion() {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x)),
    radians = Math.PI / 180;
  const p = { awake: 0, angle: 13, x: -7, gazeX: 0, gazeY: 0, lids: 0 },
    velocity = Object.fromEntries(Object.keys(p).map((k) => [k, 0]));
  let state = 'rest',
    target = { x: 744, y: 444 },
    now = 0,
    stateAt = 0,
    blinkAt = 4300,
    reduced = false,
    pulse = 0;
  const spring = (key, to, frequency, dt) => {
    // Exact critically damped integration is stable across frame rates and reversals.
    const delta = p[key] - to,
      c = velocity[key] + frequency * delta,
      e = Math.exp(-frequency * dt);
    p[key] = to + (delta + c * dt) * e;
    velocity[key] = (velocity[key] - frequency * c * dt) * e;
  };
  function step(ms) {
    const dt = clamp(ms, 0, 80) / 1000;
    now += dt * 1000;
    pulse *= Math.exp(-dt * 7);
    const caught = state === 'caught',
      surprise = caught && now - stateAt < 125;
    const watching = state === 'peek' || surprise;
    const dx = target.x - 346,
      dy = target.y - 663;
    const fieldAngle = clamp(Math.atan2(dy, dx) / radians + 31, -26, 37);
    const angle = watching ? fieldAngle : 13;
    const targetAwake = watching ? 1 : 0;
    const localAngle = Math.atan2(dy, dx) - p.angle * radians;
    const gazeX = watching ? Math.cos(localAngle) * 3.7 : 0,
      gazeY = watching ? Math.sin(localAngle) * 3.9 : 0;
    let blink = 1;
    if (now >= blinkAt) {
      const elapsed = now - blinkAt;
      blink = elapsed < 75 ? 1 - elapsed / 75 : clamp((elapsed - 75) / 145, 0, 1);
      if (elapsed > 220) blinkAt = now + 3700 + Math.sin(now) * 650;
    }
    const lidTarget = watching ? (surprise ? 1 : blink) : 0;
    const targets = {
      awake: targetAwake,
      angle,
      x: watching ? (surprise ? -10 : 9) : -7,
      gazeX,
      gazeY,
      lids: lidTarget,
    };
    if (reduced) {
      for (const key of Object.keys(p)) {
        p[key] = targets[key];
        velocity[key] = 0;
      }
    } else {
      spring('awake', targetAwake, watching ? 4.7 : 5.7, dt);
      spring('angle', angle, 7.5, dt);
      spring('x', targets.x, 7, dt);
      spring('gazeX', gazeX, 19, dt);
      spring('gazeY', gazeY, 19, dt);
      spring('lids', lidTarget, watching ? 25 : 17, dt);
    }
    const asleep = 1 - p.awake,
      breathe = reduced ? 0 : Math.sin(now / 720) * 0.9;
    const y = asleep * 89 - pulse * 2.2 * p.awake + breathe * (0.3 + 0.6 * asleep);
    const frontY = asleep * 28;
    const ear = reduced ? 0 : Math.sin(now / 930) * 0.65 * p.awake + Math.sin(pulse * 2) * 1.2;
    return {
      ...p,
      y,
      frontY,
      frontScale: 1 + asleep * 0.075,
      breathe,
      ear,
      time: now,
      state,
      target: { ...target },
      fieldAngle,
    };
  }
  return {
    step,
    setState(next) {
      if (next !== state) {
        state = next;
        stateAt = now;
      }
    },
    lookAt(point) {
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) target = { x: point.x, y: point.y };
    },
    nudge() {
      pulse = Math.min(1, pulse + 0.3);
    },
    setReduced(value) {
      reduced = value;
    },
    get state() {
      return state;
    },
  };
}
