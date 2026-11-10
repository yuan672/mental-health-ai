/* global document */
// Continuous watercolor puppet: one torso, one head, two articulated forelegs.
// No pose atlas, key-pose image switching, optical flow, or per-frame TPS solves.

const CAT_WC_CROPS = {
  head: [64, 44, 448, 500],
  body: [525, 132, 565, 375],
  near: [1130, 50, 368, 450],
  far: [94, 537, 360, 405],
};
const catWcClamp = (n, a, b) => Math.max(a, Math.min(b, n));
const catWcSmooth = (a, b, v) => {
  const t = catWcClamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function catWcLimb(shoulderX, wrist, lengths, reach) {
  const [a, b] = lengths,
    d = reach,
    dx = wrist[0] - shoulderX,
    dy = Math.sqrt(Math.max(1, d * d - dx * dx)),
    shoulder = [shoulderX, wrist[1] - dy];
  const along = (a * a - b * b + d * d) / (2 * d),
    height = Math.sqrt(Math.max(0, a * a - along * along));
  return {
    shoulder,
    elbow: [
      shoulder[0] + (dx / d) * along - (dy / d) * height,
      shoulder[1] + (dy / d) * along + (dx / d) * height,
    ],
    wrist,
    lengths,
  };
}
function loginCatWatercolorPose(p) {
  const progress = catWcClamp(p.awake, 0, 1),
    brace = catWcSmooth(0, 0.18, progress),
    push = catWcSmooth(0.12, 1, progress),
    lean = catWcSmooth(0.76, 1, progress);
  const nearW = [310 + 8 * brace, 355],
    farW = [368 + 6 * brace, 348];
  // Reposition the paws without lifting the shoulders; then increase extension.
  const nearRestReach = Math.hypot(nearW[0] - 273, Math.sqrt(72 * 72 - 37 * 37));
  const farRestReach = Math.hypot(farW[0] - 334, Math.sqrt(74 * 74 - 34 * 34));
  const near = catWcLimb(
    273 + 7 * push + 3 * lean,
    nearW,
    [58, 62],
    nearRestReach * (1 - push) + 110 * push,
  );
  const far = catWcLimb(
    334 + 6 * push + 2 * lean,
    farW,
    [61, 57],
    farRestReach * (1 - push) + 108 * push,
  );
  const neck = [near.shoulder[0] + 25, near.shoulder[1] + 24 + (1 - push) * 30];
  const angle =
    (((1 - push) * 24 + push * catWcClamp((p.angle - 2) * 0.65, -14, 17)) * Math.PI) / 180;
  return {
    near,
    far,
    neck,
    angle,
    progress,
    push,
    brace,
    lean,
    breathe: p.breathe || 0,
    lids: catWcClamp(p.lids, 0, 1),
    gazeX: p.gazeX || 0,
    gazeY: p.gazeY || 0,
  };
}
function catWcPrepare(images, makeCanvas) {
  const sheets = {};
  for (const [name, img] of [
    ['open', images.open],
    ['closed', images.closed],
  ]) {
    const c = makeCanvas(1536, 1024),
      ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 1536, 1024);
    sheets[name] = c;
  }
  function extract(name, closed = false) {
    const [x, y, w, h] = CAT_WC_CROPS[name],
      c = makeCanvas(w, h),
      ctx = c.getContext('2d');
    ctx.drawImage(sheets[closed ? 'closed' : 'open'], x, y, w, h, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h),
      d = pixels.data,
      visited = new Uint8Array(w * h),
      queue = new Int32Array(w * h);
    let end = 0,
      start = 0;
    const add = (i) => {
      if (i < 0 || i >= visited.length || visited[i]) return;
      const k = i * 4;
      if (Math.min(d[k], d[k + 1], d[k + 2]) < 239) return;
      visited[i] = 1;
      queue[end++] = i;
    };
    for (let u = 0; u < w; u++) {
      add(u);
      add((h - 1) * w + u);
    }
    for (let v = 0; v < h; v++) {
      add(v * w);
      add(v * w + w - 1);
    }
    while (start < end) {
      const i = queue[start++],
        u = i % w;
      if (u) add(i - 1);
      if (u < w - 1) add(i + 1);
      add(i - w);
      add(i + w);
    }
    for (let i = 0; i < visited.length; i++)
      if (visited[i]) {
        const u = i % w,
          v = Math.floor(i / w);
        // Unoutlined cream fur at the neck is foreground, even where it touches
        // the white paper. Keep that overlap area solid instead of punching holes.
        const taper = catWcSmooth(380, 485, v);
        const neckFur =
          name === 'head' && v > 295 && v < 480 && u > 100 + 75 * taper && u < 310 - 90 * taper;
        if (!neckFur) d[i * 4 + 3] = 0;
      }
    if (name === 'head')
      for (let v = 448; v < h; v++)
        for (let u = 0; u < w; u++) d[(v * w + u) * 4 + 3] *= 1 - catWcSmooth(448, 490, v);
    ctx.putImageData(pixels, 0, 0);
    return c;
  }
  return {
    head: extract('head'),
    closedHead: extract('head', true),
    body: extract('body'),
    near: extract('near'),
    far: extract('far'),
  };
}
function catWcMesh(source, cols, rows) {
  const points = [],
    triangles = [],
    ys = Array.isArray(rows)
      ? rows
      : Array.from({ length: rows + 1 }, (_, i) => (i / rows) * source.height);
  for (const y of ys) for (let x = 0; x <= cols; x++) points.push([(x / cols) * source.width, y]);
  for (let y = 0; y < ys.length - 1; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * (cols + 1) + x;
      triangles.push([i, i + 1, i + cols + 1], [i + 1, i + cols + 2, i + cols + 1]);
    }
  return { source, points, dest: points.map(() => [0, 0]), triangles };
}
function catWcDrawMesh(ctx, mesh, map) {
  for (let i = 0; i < mesh.points.length; i++) map(mesh.points[i], mesh.dest[i]);
  for (const ids of mesh.triangles) {
    const a = mesh.points[ids[0]],
      b = mesh.points[ids[1]],
      c = mesh.points[ids[2]],
      A = mesh.dest[ids[0]],
      B = mesh.dest[ids[1]],
      C = mesh.dest[ids[2]];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      vx = c[0] - a[0],
      vy = c[1] - a[1],
      det = ux * vy - vx * uy;
    const dx = B[0] - A[0],
      dy = B[1] - A[1],
      ex = C[0] - A[0],
      ey = C[1] - A[1];
    const m0 = (dx * vy - ex * uy) / det,
      m1 = (dy * vy - ey * uy) / det,
      m2 = (ex * ux - dx * vx) / det,
      m3 = (ey * ux - dy * vx) / det;
    const winding = dx * ey - dy * ex >= 0 ? 1 : -1;
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const v = mesh.dest[ids[k]],
        prev = mesh.dest[ids[(k + 2) % 3]],
        next = mesh.dest[ids[(k + 1) % 3]];
      const ax = v[0] - prev[0],
        ay = v[1] - prev[1],
        bx = next[0] - v[0],
        by = next[1] - v[1],
        al = Math.hypot(ax, ay) || 1,
        bl = Math.hypot(bx, by) || 1;
      const nx = (ay / al) * winding,
        ny = (-ax / al) * winding,
        mx = (by / bl) * winding,
        my = (-bx / bl) * winding,
        amount = 0.55 / Math.max(0.01, 1 + nx * mx + ny * my);
      const x = v[0] + (nx + mx) * amount,
        y = v[1] + (ny + my) * amount;
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.transform(m0, m1, m2, m3, A[0] - m0 * a[0] - m2 * a[1], A[1] - m1 * a[0] - m3 * a[1]);
    ctx.drawImage(mesh.source, 0, 0);
    ctx.restore();
  }
}
function catWcLegMap(limb, isFar) {
  const S = isFar ? [139, 73] : [135, 75],
    E = isFar ? [174, 217] : [173, 234],
    W = isFar ? [273, 335] : [274, 363];
  const upperAngle =
    Math.atan2(limb.elbow[1] - limb.shoulder[1], limb.elbow[0] - limb.shoulder[0]) -
    Math.atan2(E[1] - S[1], E[0] - S[0]);
  const lowerAngle =
    Math.atan2(limb.wrist[1] - limb.elbow[1], limb.wrist[0] - limb.elbow[0]) -
    Math.atan2(W[1] - E[1], W[0] - E[0]);
  const upperScale = limb.lengths[0] / Math.hypot(E[0] - S[0], E[1] - S[1]),
    lowerScale = limb.lengths[1] / Math.hypot(W[0] - E[0], W[1] - E[1]);
  return (v, out) => {
    const t = catWcSmooth(E[1] - 48, E[1] + 48, v[1]),
      angle = upperAngle + (lowerAngle - upperAngle) * t,
      scale = upperScale + (lowerScale - upperScale) * t;
    const dx = v[0] - E[0],
      dy = v[1] - E[1],
      c = Math.cos(angle),
      s = Math.sin(angle);
    let x = limb.elbow[0] + (dx * c - dy * s) * scale,
      y = limb.elbow[1] + (dx * s + dy * c) * scale;
    const foot = catWcSmooth(W[1] - 18, W[1] + 22, v[1]),
      footAngle = -0.17,
      fc = Math.cos(footAngle),
      fs = Math.sin(footAngle),
      fx = v[0] - W[0],
      fy = v[1] - W[1];
    x += (limb.wrist[0] + (fx * fc - fy * fs) * lowerScale - x) * foot;
    y += (limb.wrist[1] + (fx * fs + fy * fc) * lowerScale - y) * foot;
    out[0] = x;
    out[1] = y;
  };
}
function catWcHeadMap(pose) {
  const c = Math.cos(pose.angle),
    s = Math.sin(pose.angle);
  return (v, out) => {
    const dx = (v[0] - 204) * 0.43,
      dy = (v[1] - 365) * 0.43;
    const x = pose.neck[0] + dx * c - dy * s,
      y = pose.neck[1] + dx * s + dy * c;
    const chest = catWcSmooth(305, 495, v[1]);
    out[0] = x + (pose.near.shoulder[0] + 25 + dx - x) * chest;
    out[1] = y + (pose.near.shoulder[1] + 24 + dy - y) * chest;
  };
}
function catWcHeadMesh(source) {
  const mesh = catWcMesh(source, 4, [0, 305, 325, 345, 365, 385, 405, 425, 445, 465, 485, 500]);
  // Follow the painted neck's narrowing silhouette. The empty rectangle beyond
  // the right edge must not become a folded sheet as the neck bends.
  for (const v of mesh.points) v[0] *= (448 - 118 * catWcSmooth(285, 365, v[1])) / 448;
  return mesh;
}
function createLoginCatWatercolorCanvas(canvas, images, makeCanvas) {
  makeCanvas =
    makeCanvas ||
    ((w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    });
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  canvas.width = 810;
  canvas.height = 680;
  const assets = catWcPrepare(images, makeCanvas),
    body = catWcMesh(assets.body, 12, 8),
    near = catWcMesh(assets.near, 6, 16),
    far = catWcMesh(assets.far, 6, 16);
  const head = makeCanvas(448, 500),
    hc = head.getContext('2d'),
    headMesh = catWcHeadMesh(head);
  const eyes = [
    [194, 222, 44, 42],
    [317, 172, 32, 39],
  ];
  let disposed = false;
  return {
    mode: 'watercolor-canvas',
    draw(p) {
      if (disposed) return;
      const pose = loginCatWatercolorPose(p);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 810, 680);
      ctx.scale(810 / 500, 680 / 420);
      catWcDrawMesh(ctx, far, catWcLegMap(pose.far, true));
      catWcDrawMesh(ctx, body, (v, out) => {
        const x = 48 + v[0] * 0.505,
          y = 192 + v[1] * 0.5,
          w = catWcSmooth(157, 305, x) * (1 - catWcSmooth(300, 380, y));
        out[0] = x + (pose.near.shoulder[0] - 283) * w;
        out[1] = y + (pose.near.shoulder[1] - 251) * w + pose.breathe * 0.24 * (1 - w);
      });
      catWcDrawMesh(ctx, near, catWcLegMap(pose.near, false));
      hc.clearRect(0, 0, 448, 500);
      hc.drawImage(assets.head, 0, 0);
      hc.save();
      hc.beginPath();
      for (const [x, y, rx, ry] of eyes) {
        hc.moveTo(x + rx + 12, y);
        hc.ellipse(x, y, rx + 12, ry + 12, 0, 0, Math.PI * 2);
      }
      hc.clip();
      hc.drawImage(assets.closedHead, 0, 0);
      hc.globalAlpha = pose.lids;
      hc.drawImage(assets.head, pose.gazeX * 0.85 * pose.lids, pose.gazeY * 0.85 * pose.lids);
      hc.restore();
      catWcDrawMesh(ctx, headMesh, catWcHeadMap(pose));
    },
    dispose() {
      disposed = true;
      head.width = 1;
      for (const c of Object.values(assets)) c.width = 1;
    },
  };
}
export function createLoginCatWatercolorRenderer(canvas, images, makeCanvas) {
  makeCanvas =
    makeCanvas ||
    ((w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    });
  let gl = null;
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  } catch {
    /* Some Canvas implementations throw instead of returning null. */
  }
  if (!gl) return createLoginCatWatercolorCanvas(canvas, images, makeCanvas);
  const assets = catWcPrepare(images, makeCanvas),
    body = catWcMesh(assets.body, 12, 8),
    near = catWcMesh(assets.near, 6, 16),
    far = catWcMesh(assets.far, 6, 16),
    head = catWcHeadMesh(assets.head);
  const compile = (type, code) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, code);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vs = compile(
    gl.VERTEX_SHADER,
    'attribute vec2 point;attribute vec2 texcoord;varying vec2 uv;void main(){gl_Position=vec4(point,0.,1.);uv=texcoord;}',
  );
  const fs = compile(
    gl.FRAGMENT_SHADER,
    `precision mediump float;varying vec2 uv;uniform sampler2D art;uniform sampler2D sleeping;uniform float headLayer;uniform vec3 gaze;
    void main(){vec4 color=texture2D(art,uv);if(headLayer>.5){vec2 px=uv*vec2(448.,500.);float q1=length((px-vec2(194.,222.))/vec2(56.,54.));float q2=length((px-vec2(317.,172.))/vec2(44.,51.));float mask=1.-smoothstep(.82,1.,min(q1,q2));vec3 shut=texture2D(sleeping,uv).rgb;vec3 watching=texture2D(art,uv-gaze.xy*.85*gaze.z*mask/vec2(448.,500.)).rgb;color.rgb=mix(color.rgb,mix(shut,watching,gaze.z),mask);}gl_FragColor=vec4(color.rgb*color.a,color.a);}`,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const vertices = new Float32Array(600 * 3 * 4);
  gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
  for (const [name, offset] of [
    ['point', 0],
    ['texcoord', 8],
  ]) {
    const i = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, 2, gl.FLOAT, false, 16, offset);
  }
  const textures = new Map();
  for (const source of Object.values(assets)) {
    const texture = gl.createTexture();
    textures.set(source, texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }
  const layer = gl.getUniformLocation(program, 'headLayer'),
    gaze = gl.getUniformLocation(program, 'gaze');
  gl.uniform1i(gl.getUniformLocation(program, 'art'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'sleeping'), 1);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures.get(assets.closedHead));
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  canvas.width = 810;
  canvas.height = 680;
  gl.viewport(0, 0, 810, 680);
  function draw(mesh, map, isHead = false) {
    for (let i = 0; i < mesh.points.length; i++) map(mesh.points[i], mesh.dest[i]);
    let offset = 0;
    for (const ids of mesh.triangles)
      for (const i of ids) {
        const v = mesh.dest[i],
          uv = mesh.points[i];
        vertices[offset++] = v[0] / 250 - 1;
        vertices[offset++] = 1 - v[1] / 210;
        vertices[offset++] = uv[0] / mesh.source.width;
        vertices[offset++] = uv[1] / mesh.source.height;
      }
    gl.bindTexture(gl.TEXTURE_2D, textures.get(mesh.source));
    gl.uniform1f(layer, isHead ? 1 : 0);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices.subarray(0, offset));
    gl.drawArrays(gl.TRIANGLES, 0, offset / 4);
  }
  return {
    mode: 'watercolor-webgl',
    draw(p) {
      const pose = loginCatWatercolorPose(p);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform3f(gaze, pose.gazeX, pose.gazeY, pose.lids);
      draw(far, catWcLegMap(pose.far, true));
      draw(body, (v, out) => {
        const x = 48 + v[0] * 0.505,
          y = 192 + v[1] * 0.5,
          w = catWcSmooth(157, 305, x) * (1 - catWcSmooth(300, 380, y));
        out[0] = x + (pose.near.shoulder[0] - 283) * w;
        out[1] = y + (pose.near.shoulder[1] - 251) * w + pose.breathe * 0.24 * (1 - w);
      });
      draw(near, catWcLegMap(pose.near, false));
      draw(head, catWcHeadMap(pose), true);
    },
    dispose() {
      for (const texture of textures.values()) gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      for (const v of Object.values(assets)) v.width = 1;
    },
  };
}
