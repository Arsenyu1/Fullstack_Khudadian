/* Draft: the original constellation behavior plus a softly advected cursor wake.
 * No card DOM, styles, links or event defaults are changed. No dependencies.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('bg-anim');
  if (!canvas || canvas.dataset.starfieldMounted) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  canvas.dataset.starfieldMounted = 'true';
  canvas.setAttribute('aria-hidden', 'true');

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const mouse = matchMedia('(any-hover: hover) and (any-pointer: fine)');
  const preview = new URLSearchParams(location.search).has('preview');
  const mist = document.createElement('canvas');
  const mistCtx = mist.getContext('2d');
  if (!mistCtx) return;
  let w = 0, h = 0, dpr = 1, cols = 0, rows = 0, count = 0;
  let u, v, u0, v0, ink, ink0, pressure, pressure0, divergence, pixels;
  let raf = 0, lastTime = 0, simulationTime = 0, lastInput = -10;
  let pointer = null, pending = null, demoStart = 0;
  let shiftX = 0, shiftY = 0;
  const focus = { x: 0.5, y: 0.5 };
  const STAR_COUNT = 250, NEIGHBORS = 3;
  const neighbors = new Int16Array(STAR_COUNT * NEIGHBORS);
  const neighborDistances = new Float32Array(STAR_COUNT * NEIGHBORS);
  const connections = new Uint8Array(STAR_COUNT * STAR_COUNT);
  const connectionLight = new Float32Array(STAR_COUNT * STAR_COUNT);
  let graphTime = -1, nextSparkTime = 0, suppressSparksUntil = 0;
  let seed = 78291;
  const stars = [];
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

  function resize() {
    w = innerWidth;
    h = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = Math.max(8, Math.sqrt(w * h / 13500));
    cols = Math.max(24, Math.ceil(w / cell));
    rows = Math.max(24, Math.ceil(h / cell));
    count = cols * rows;
    [u, v, u0, v0, ink, ink0, pressure, pressure0, divergence] =
      Array.from({ length: 9 }, () => new Float32Array(count));
    mist.width = cols;
    mist.height = rows;
    pixels = mistCtx.createImageData(cols, rows);
    const total = STAR_COUNT;
    while (stars.length < total) {
      const depth = random();
      stars.push({
        x: random(), y: random(), depth,
        vx: 6 - random() * 30, vy: 6 - random() * 30,
        ox: 0, oy: 0, kickX: 0, kickY: 0, screenX: 0, screenY: 0,
        jointLight: 0, sparkTime: -10, sparkWaitingUntil: 0, nextSpark: 0,
        radius: 0.3 + depth * depth * 2.7,
        alpha: 0.6 + random() * 0.3,
        phase: random() * Math.PI * 2,
        speed: 0.22 + random() * 0.42,
        warm: random() > 0.94
      });
    }
    stars.length = total;
    connections.fill(0);
    connectionLight.fill(0);
    graphTime = -1;
    resetSparks();
    pointer = null;
    pending = null;
    lastInput = -10;
    draw(simulationTime);
  }

  function sample(field, x, y) {
    x = clamp(x, 0.5, cols - 1.5);
    y = clamp(y, 0.5, rows - 1.5);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const a = x - x0, b = y - y0, i = y0 * cols + x0;
    return (field[i] * (1 - a) + field[i + 1] * a) * (1 - b) +
      (field[i + cols] * (1 - a) + field[i + cols + 1] * a) * b;
  }

  function addInk(x, y, dx, dy, strength) {
    const gx = x / w * (cols - 1), gy = y / h * (rows - 1);
    const radius = Math.max(1.6, Math.min(cols, rows) * 0.021);
    const reach = radius * 3;
    const speedX = clamp(dx / w * cols * 75, -230, 230);
    const speedY = clamp(dy / h * rows * 75, -230, 230);
    for (let iy = Math.max(1, Math.floor(gy - reach)); iy < Math.min(rows - 1, gy + reach); iy++) {
      for (let ix = Math.max(1, Math.floor(gx - reach)); ix < Math.min(cols - 1, gx + reach); ix++) {
        const i = iy * cols + ix;
        const falloff = Math.exp(-((ix - gx) ** 2 + (iy - gy) ** 2) / (radius * radius));
        ink[i] = Math.min(2.2, ink[i] + falloff * strength);
        u[i] = clamp(u[i] + speedX * falloff, -290, 290);
        v[i] = clamp(v[i] + speedY * falloff, -290, 290);
      }
    }
    lastInput = simulationTime;
  }

  function simulate(dt) {
    const velocityFade = Math.exp(-1.7 * dt);
    const inkFade = Math.exp(-1.4 * dt);
    // Semi-Lagrangian advection: carry velocity through its own flow.
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        const px = x - u[i] * dt, py = y - v[i] * dt;
        u0[i] = sample(u, px, py) * velocityFade;
        v0[i] = sample(v, px, py) * velocityFade;
      }
    }
    [u, u0] = [u0, u];
    [v, v0] = [v0, v];
    // Project out divergence, so the wake spreads and rolls naturally.
    pressure.fill(0);
    pressure0.fill(0);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        divergence[i] = -0.5 * (u[i + 1] - u[i - 1] + v[i + cols] - v[i - cols]);
      }
    }
    for (let iteration = 0; iteration < 12; iteration++) {
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          const i = y * cols + x;
          pressure0[i] = (divergence[i] + pressure[i - 1] + pressure[i + 1] +
            pressure[i - cols] + pressure[i + cols]) * 0.25;
        }
      }
      [pressure, pressure0] = [pressure0, pressure];
    }
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        u[i] -= 0.5 * (pressure[i + 1] - pressure[i - 1]);
        v[i] -= 0.5 * (pressure[i + cols] - pressure[i - cols]);
      }
    }
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        ink0[i] = sample(ink, x - u[i] * dt, y - v[i] * dt) * inkFade;
      }
    }
    [ink, ink0] = [ink0, ink];
  }

  function moveStars(dt) {
    for (const star of stars) {
      // Keep the original slow drift and reflection at the viewport edges.
      star.x += star.vx * dt / w;
      star.y += star.vy * dt / h;
      if (star.x < 0 || star.x > 1) {
        star.vx = star.x < 0 ? Math.abs(star.vx) : -Math.abs(star.vx);
        star.x = clamp(star.x, 0, 1);
      }
      if (star.y < 0 || star.y > 1) {
        star.vy = star.y < 0 ? Math.abs(star.vy) : -Math.abs(star.vy);
        star.y = clamp(star.y, 0, 1);
      }
      let forceX = 0, forceY = 0;
      if (pointer) {
        const dx = star.x * w + star.ox + shiftX * star.depth - pointer.x;
        const dy = star.y * h + star.oy + shiftY * star.depth - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 125) {
          const force = 380 * (1 - distance / 125) ** 2;
          forceX = (distance > 0.01 ? dx / distance : Math.cos(star.phase)) * force;
          forceY = (distance > 0.01 ? dy / distance : Math.sin(star.phase)) * force;
        }
      }
      // A bounded, spring-driven offset adds scattering without losing the drift.
      star.kickX = (star.kickX + (forceX - star.ox * 5) * dt) * Math.exp(-4 * dt);
      star.kickY = (star.kickY + (forceY - star.oy * 5) * dt) * Math.exp(-4 * dt);
      star.ox = clamp(star.ox + star.kickX * dt, -85, 85);
      star.oy = clamp(star.oy + star.kickY * dt, -85, 85);
    }
  }

  function resetSparks() {
    suppressSparksUntil = simulationTime + 0.65;
    nextSparkTime = suppressSparksUntil;
    for (const star of stars) {
      star.sparkTime = -10;
      star.sparkWaitingUntil = 0;
    }
  }

  function offerNeighbor(i, j, distance) {
    const start = i * NEIGHBORS;
    for (let slot = 0; slot < NEIGHBORS; slot++) {
      if (distance >= neighborDistances[start + slot]) continue;
      for (let k = NEIGHBORS - 1; k > slot; k--) {
        neighbors[start + k] = neighbors[start + k - 1];
        neighborDistances[start + k] = neighborDistances[start + k - 1];
      }
      neighbors[start + slot] = j;
      neighborDistances[start + slot] = distance;
      break;
    }
  }

  function updateGraph(time) {
    if (!motion.matches && graphTime >= 0 && time - graphTime < 0.1) return;
    graphTime = time;
    neighbors.fill(-1);
    neighborDistances.fill(Infinity);
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].screenX - stars[j].screenX;
        const dy = stars[i].screenY - stars[j].screenY;
        const distance = dx * dx + dy * dy;
        const existing = connectionLight[i * STAR_COUNT + j] > 0.03;
        if (distance > (existing ? 104 * 104 : 90 * 90)) continue;
        // Favor existing neighbors slightly to keep the topology from flickering.
        const score = distance * (existing ? 0.78 : 1);
        offerNeighbor(i, j, score);
        offerNeighbor(j, i, score);
      }
    }
    connections.fill(0);
    for (let i = 0; i < stars.length; i++) {
      for (let slot = 0; slot < NEIGHBORS; slot++) {
        const j = neighbors[i * NEIGHBORS + slot];
        if (j <= i) continue;
        for (let other = 0; other < NEIGHBORS; other++) {
          if (neighbors[j * NEIGHBORS + other] === i) {
            connections[i * STAR_COUNT + j] = 1;
            break;
          }
        }
      }
    }
  }

  function drawConnections(time, dt) {
    updateGraph(time);
    const fx = focus.x * w, fy = focus.y * h;
    const appear = motion.matches ? 1 : 1 - Math.exp(-10 * dt);
    const disappear = motion.matches ? 1 : 1 - Math.exp(-6 * dt);
    ctx.lineWidth = 0.65;
    for (const star of stars) star.jointLight = 0;
    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const index = i * STAR_COUNT + j;
        const previous = connectionLight[index];
        if (!connections[index] && previous < 0.002) continue;
        const b = stars[j];
        const distance = Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY);
        const proximity = Math.min(Math.hypot(a.screenX - fx, a.screenY - fy),
          Math.hypot(b.screenX - fx, b.screenY - fy));
        const focusFade = clamp((310 - proximity) / 100, 0, 1);
        const lengthFade = clamp((104 - distance) / 52, 0, 1);
        const target = connections[index] ? focusFade * lengthFade : 0;
        const light = previous + (target - previous) * (target > previous ? appear : disappear);
        connectionLight[index] = light < 0.002 ? 0 : light;
        if (light < 0.01) continue;
        a.jointLight = Math.max(a.jointLight, light);
        b.jointLight = Math.max(b.jointLight, light);
        if (!motion.matches && time >= suppressSparksUntil && previous < 0.28 && light >= 0.28) {
          a.sparkWaitingUntil = time + 0.65;
          b.sparkWaitingUntil = time + 0.65;
        }
        ctx.strokeStyle = `rgba(85,168,255,${0.28 * light})`;
        ctx.beginPath();
        ctx.moveTo(a.screenX, a.screenY);
        ctx.lineTo(b.screenX, b.screenY);
        ctx.stroke();
      }
    }
    if (motion.matches || time < nextSparkTime) return;
    let active = 0, candidate = null, bestScore = -Infinity;
    for (const star of stars) {
      if (time - star.sparkTime < 0.65) active++;
      if (time >= star.sparkWaitingUntil || time < star.nextSpark || star.jointLight < 0.25) continue;
      const distance = Math.hypot(star.screenX - fx, star.screenY - fy);
      const score = star.jointLight - distance / 600 + star.depth * 0.1;
      if (score > bestScore) { candidate = star; bestScore = score; }
    }
    if (candidate && active < 3) {
      candidate.sparkTime = time;
      candidate.sparkWaitingUntil = 0;
      candidate.nextSpark = time + 2.5;
      nextSparkTime = time + 0.35;
    }
  }

  function draw(time, dt = 0) {
    ctx.clearRect(0, 0, w, h);
    if (!motion.matches && time - lastInput < 4) {
      const tint = 0.5 + Math.sin(time * 0.14) * 0.5;
      for (let i = 0; i < count; i++) {
        const j = i * 4;
        pixels.data[j] = 43 + tint * 26;
        pixels.data[j + 1] = 126 + tint * 72;
        pixels.data[j + 2] = 222;
        pixels.data[j + 3] = Math.min(175, (1 - Math.exp(-ink[i] * 1.4)) * 220);
      }
      mistCtx.putImageData(pixels, 0, 0);
      ctx.save();
      ctx.filter = 'blur(3px)';
      ctx.drawImage(mist, 0, 0, w, h);
      ctx.restore();
    }
    for (const star of stars) {
      star.screenX = star.x * w + star.ox + shiftX * star.depth;
      star.screenY = star.y * h + star.oy + shiftY * star.depth;
    }
    drawConnections(time, dt);
    for (const star of stars) {
      const x = star.screenX, y = star.screenY;
      const twinkle = motion.matches ? 1 : 0.86 + Math.sin(time * star.speed + star.phase) * 0.14;
      const alpha = star.alpha * twinkle;
      const color = star.warm ? '177,217,255' : '50,150,255';
      if (star.depth > 0.88) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, star.radius * 5);
        glow.addColorStop(0, `rgba(${color},${alpha * 0.21})`);
        glow.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, star.radius * 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${color},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, star.radius, 0, Math.PI * 2);
      ctx.fill();
      const age = time - star.sparkTime;
      const pulse = !motion.matches && age >= 0 && age < 0.65
        ? Math.sin(Math.PI * clamp(age / 0.1, 0, 1) / 2) * (1 - age / 0.65) ** 2 : 0;
      const joint = star.jointLight;
      if (joint > 0.12 || pulse > 0) {
        const radius = 4 + pulse * 4;
        const halo = ctx.createRadialGradient(x, y, 0, x, y, radius);
        halo.addColorStop(0, `rgba(165,216,255,${joint * 0.065 + pulse * 0.22})`);
        halo.addColorStop(0.4, `rgba(108,185,255,${joint * 0.025 + pulse * 0.08})`);
        halo.addColorStop(1, 'rgba(85,168,255,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(229,245,255,${joint * 0.12 + pulse * 0.7})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.min(star.radius, 1) + pulse * 0.35, 0, Math.PI * 2);
        ctx.fill();
        if (pulse > 0.25) {
          const ray = 2.2 + pulse * 3;
          ctx.strokeStyle = `rgba(197,231,255,${pulse * 0.23})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(x - ray, y); ctx.lineTo(x + ray, y);
          ctx.moveTo(x, y - ray); ctx.lineTo(x, y + ray);
          ctx.stroke();
        }
      }
    }
  }

  function tick(now) {
    raf = 0;
    if (document.hidden || motion.matches) return;
    const dt = Math.min((now - (lastTime || now - 16.67)) / 1000, 0.034);
    lastTime = now;
    simulationTime += dt;
    if (demoStart) {
      const elapsed = (now - demoStart) / 1000;
      if (elapsed > 7) {
        demoStart = 0;
        pointer = null;
      } else {
        // Preview only: a visible demonstration along the left side of the card.
        const span = Math.max(40, (w - Math.min(420, w * 0.95)) / 2);
        const x = span * (0.53 + Math.sin(elapsed * 2.8) * 0.3);
        const y = h * (0.5 + Math.sin(elapsed * 1.9) * 0.27);
        pending = { x, y };
      }
    }
    if (pending) {
      const next = pending;
      pending = null;
      if (pointer) {
        const dx = next.x - pointer.x, dy = next.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        const steps = Math.min(14, Math.max(1, Math.ceil(distance / 14)));
        if (distance > 0.1) {
          for (let i = 1; i <= steps; i++) {
            addInk(pointer.x + dx * i / steps, pointer.y + dy * i / steps,
              dx / steps, dy / steps, Math.min(0.62, 0.09 + distance / steps * 0.024));
          }
        }
      }
      pointer = next;
      focus.x = next.x / w;
      focus.y = next.y / h;
    }
    const tx = pointer ? (pointer.x / w - 0.5) * 12 : 0;
    const ty = pointer ? (pointer.y / h - 0.5) * 9 : 0;
    const easing = 1 - Math.exp(-3 * dt);
    shiftX += (tx - shiftX) * easing;
    shiftY += (ty - shiftY) * easing;
    moveStars(dt);
    if (simulationTime - lastInput < 4) simulate(dt);
    draw(simulationTime, dt);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (raf || document.hidden || motion.matches) return;
    lastTime = 0;
    raf = requestAnimationFrame(tick);
  }
  function resetPointer() { pointer = null; pending = null; demoStart = 0; }
  addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !mouse.matches || motion.matches) return;
    demoStart = 0;
    pending = { x: event.clientX, y: event.clientY };
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', resetPointer, { passive: true });
  addEventListener('blur', resetPointer);
  addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      resetPointer();
      resetSparks();
    } else start();
  });
  motion.addEventListener('change', () => {
    cancelAnimationFrame(raf);
    raf = 0;
    resetPointer();
    resetSparks();
    ink.fill(0);
    draw(simulationTime);
    start();
  });
  if (preview) {
    addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== parent) return;
      if (event.data?.type === 'preview:demo' && !motion.matches) {
        pointer = null;
        demoStart = performance.now();
        start();
      }
    });
  }
  resize();
  start();
})();
