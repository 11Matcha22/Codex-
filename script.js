const STAGE_COUNT = 50;
const STORAGE_KEY = "hook_swing_progress_v1";
// 調整用の設定ファイルが読み込めなかった時の安全な既定値
const DEFAULT_CONFIG = {
  features: {
    clearCinematic: true,
    clearEvaluation: true,
  },
  clear: {
    durationMs: 850,
    slowMotionScale: 0.25,
  },
  trampoline: {
    verticalScale: 0.5,
    horizontalScale: 0.5,
  },
};

const screens = {
  title: document.getElementById("titleScreen"),
  select: document.getElementById("selectScreen"),
  game: document.getElementById("gameScreen"),
};

const stageInfoEl = document.getElementById("stageInfo");
const timerEl = document.getElementById("timer");
const reachedCountEl = document.getElementById("reachedCount");
const clearedCountEl = document.getElementById("clearedCount");
const totalBestEl = document.getElementById("totalBest");
const stageGridEl = document.getElementById("stageGrid");
const gameScreenEl = document.getElementById("gameScreen");

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const state = {
  // ゲーム進行・描画・演出で使う共有状態
  progress: loadProgress(),
  stages: makeStages(STAGE_COUNT),
  currentStageIndex: 0,
  running: false,
  stageStartMs: 0,
  elapsedSec: 0,
  lastTs: 0,
  accumulator: 0,
  cameraX: 0,
  pointerDown: false,
  player: null,
  hookedAnchor: null,
  lockedAnchor: null,
  tapCount: 0,
  clearSequence: null,
  config: structuredClone(DEFAULT_CONFIG),
};

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        reachedMax: 1,
        cleared: {},
        bestTimes: {},
      };
    }
    const parsed = JSON.parse(raw);
    return {
      reachedMax: Math.max(1, Math.min(STAGE_COUNT, parsed.reachedMax || 1)),
      cleared: parsed.cleared || {},
      bestTimes: parsed.bestTimes || {},
    };
  } catch {
    return {
      reachedMax: 1,
      cleared: {},
      bestTimes: {},
    };
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
}

function getConfig(path, fallback) {
  const keys = path.split(".");
  let current = state.config;
  for (const key of keys) {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      current = current[key];
    } else {
      return fallback;
    }
  }
  return current;
}

async function loadConfig() {
  try {
    const response = await fetch("./config/gameplay.json", { cache: "no-store" });
    if (!response.ok) throw new Error("config not found");
    const loaded = await response.json();
    state.config = {
      features: { ...DEFAULT_CONFIG.features, ...(loaded.features || {}) },
      clear: { ...DEFAULT_CONFIG.clear, ...(loaded.clear || {}) },
      trampoline: { ...DEFAULT_CONFIG.trampoline, ...(loaded.trampoline || {}) },
    };
  } catch {
    state.config = structuredClone(DEFAULT_CONFIG);
  }
}

function makeStages(count) {
  const stages = [];
  for (let i = 1; i <= count; i += 1) {
    const anchors = [];
    const baseX = 280;
    const spacing = 245 - Math.min(90, i * 1.3);
    const waves = 3 + (i % 3);
    for (let a = 0; a < waves + 3; a += 1) {
      const x = baseX + a * spacing;
      const y = i <= 10
        ? 170 + a * 36 + Math.sin((a + i) * 0.7) * 22
        : 210 + Math.sin((a + i) * 0.9) * (80 + (i % 6) * 5);
      anchors.push({ x, y });
    }
    const failZoneY = 690;
    const goalX = anchors[anchors.length - 1].x + 220;
    const trampolines = [];
    if (i <= 8) {
      for (let x = 0; x <= goalX + 120; x += 110) {
        trampolines.push({ x, y: 630, w: 120, h: 16, boost: 700, angle: 0, vxBoost: 80, moveAmp: 0, moveSpeed: 0, phase: 0 });
      }
    } else {
      const countByLevel = Math.max(2, 6 - Math.floor(i / 10));
      for (let t = 0; t < countByLevel; t += 1) {
        trampolines.push({
          x: 180 + t * (goalX / (countByLevel + 1)),
          y: 610 - (t % 2) * 35,
          w: 110,
          h: 14,
          boost: 620 + (i > 25 ? 40 : 0),
          angle: i >= 30 && t % 2 === 0 ? (t % 4 === 0 ? 0.24 : -0.2) : 0,
          vxBoost: 90 + i * 1.5,
          moveAmp: i >= 24 && t === countByLevel - 1 ? 28 : 0,
          moveSpeed: i >= 24 && t === countByLevel - 1 ? 1.8 : 0,
          phase: t * 0.7,
        });
      }
      if (i >= 35) {
        const near = anchors[Math.min(2, anchors.length - 2)];
        trampolines.push({
          x: near.x - 50,
          y: near.y + 120,
          w: 90,
          h: 14,
          boost: 760,
          angle: 0.1,
          vxBoost: 160,
          moveAmp: 0,
          moveSpeed: 0,
          phase: 0,
        });
      }
    }
    const walls = i >= 32
      ? [
          { x: goalX * 0.45, y: 280, w: 24, h: 260 },
          { x: goalX * 0.68, y: 140, w: 24, h: 240 },
        ]
      : [];
    stages.push({
      id: i,
      width: goalX + 220,
      anchors,
      failZoneY,
      failMargin: 120,
      goalLineX: goalX,
      trampolines,
      walls,
    });
  }
  return stages;
}

function setScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
  });
}

function updateStatsUI() {
  reachedCountEl.textContent = String(state.progress.reachedMax);
  const clearedCount = Object.keys(state.progress.cleared).length;
  clearedCountEl.textContent = String(clearedCount);
  const hasAll = Object.keys(state.progress.bestTimes).length === STAGE_COUNT;
  if (!hasAll) {
    totalBestEl.textContent = "--";
  } else {
    const total = Object.values(state.progress.bestTimes).reduce((a, b) => a + b, 0);
    totalBestEl.textContent = `${total.toFixed(3)}s`;
  }
}

function buildStageGrid() {
  stageGridEl.innerHTML = "";
  for (let i = 1; i <= STAGE_COUNT; i += 1) {
    const btn = document.createElement("button");
    btn.textContent = String(i);
    btn.className = "stage-btn";
    const unlocked = i <= state.progress.reachedMax;
    if (!unlocked) {
      btn.disabled = true;
      btn.classList.add("locked");
    }
    if (state.progress.cleared[i]) {
      btn.classList.add("cleared");
    }
    btn.addEventListener("click", () => startStage(i - 1));
    stageGridEl.appendChild(btn);
  }
}

function initPlayer() {
  state.player = {
    x: 110,
    y: 310,
    vx: 90,
    vy: 0,
    radius: 12,
    ropeLength: 0,
  };
  state.hookedAnchor = null;
  state.lockedAnchor = null;
}

function startStage(index) {
  state.currentStageIndex = index;
  const reached = index + 1;
  if (reached > state.progress.reachedMax) {
    state.progress.reachedMax = reached;
    saveProgress();
  }
  initPlayer();
  state.elapsedSec = 0;
  state.stageStartMs = performance.now();
  state.lastTs = 0;
  state.accumulator = 0;
  state.running = true;
  state.clearSequence = null;
  state.tapCount = 0;
  stageInfoEl.textContent = `Stage ${index + 1}`;
  timerEl.textContent = "0.000s";
  setScreen("game");
  updateStatsUI();
  buildStageGrid();
}

function failAndRetry() {
  playFailBeep();
  startStage(state.currentStageIndex);
}

function clearStage() {
  const stageId = state.currentStageIndex + 1;
  const p = state.player;
  const speed = Math.hypot(p.vx, p.vy);
  const angleDeg = Math.atan2(p.vy, p.vx) * (180 / Math.PI);
  const heightFromBottom = canvas.height - p.y;
  const clearMetrics = {
    timeSec: state.elapsedSec,
    speed: Number(speed.toFixed(1)),
    angleDeg: Number(angleDeg.toFixed(1)),
    height: Number(heightFromBottom.toFixed(1)),
    taps: state.tapCount,
  };
  state.progress.cleared[stageId] = true;
  const existing = state.progress.bestTimes[stageId];
  if (existing == null || state.elapsedSec < existing) {
    state.progress.bestTimes[stageId] = state.elapsedSec;
  }
  const next = stageId + 1;
  if (next <= STAGE_COUNT && next > state.progress.reachedMax) {
    state.progress.reachedMax = next;
  }
  saveProgress();
  updateStatsUI();
  buildStageGrid();
  state.clearSequence = {
    startedAt: performance.now(),
    durationMs: getConfig("clear.durationMs", 850),
    nextStageIndex: stageId < STAGE_COUNT ? stageId : null,
    metrics: clearMetrics,
    showEvaluation: Boolean(getConfig("features.clearEvaluation", true)),
  };
}

function findClosestAnchor(maxDist = Infinity) {
  const stage = state.stages[state.currentStageIndex];
  let best = null;
  let bestD = Infinity;
  for (const anchor of stage.anchors) {
    const dx = anchor.x - state.player.x;
    const dy = anchor.y - state.player.y;
    const d = Math.hypot(dx, dy);
    if (d < bestD && d <= maxDist) {
      best = anchor;
      bestD = d;
    }
  }
  return best;
}

function hook() {
  const anchor = findClosestAnchor();
  if (!anchor) return;
  state.hookedAnchor = anchor;
  state.lockedAnchor = anchor;
  state.player.ropeLength = Math.hypot(anchor.x - state.player.x, anchor.y - state.player.y);
}

function unhook() {
  state.hookedAnchor = null;
}

function resolveTrampolines(stage, p) {
  // トランポリンの縦横勢いは外部JSONで調整できる
  const vScale = getConfig("trampoline.verticalScale", 0.5);
  const hScale = getConfig("trampoline.horizontalScale", 0.5);
  const tSec = (performance.now() - state.stageStartMs) / 1000;
  for (const t of stage.trampolines) {
    const moveOffset = t.moveAmp ? Math.sin(tSec * t.moveSpeed + t.phase) * t.moveAmp : 0;
    const cx = t.x + t.w / 2;
    const cy = t.y + moveOffset + t.h / 2;
    const angle = t.angle || 0;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;

    if (Math.abs(lx) <= t.w / 2 && Math.abs(ly) <= t.h / 2 + p.radius + 2 && p.vy > 0) {
      const nx = -Math.sin(angle);
      const ny = -Math.cos(angle);
      const dot = p.vx * nx + p.vy * ny;
      if (dot < 0) {
        p.vx -= (1.5 * dot) * nx;
        p.vy -= (1.5 * dot) * ny;
      }
      const tx = Math.cos(angle);
      const ty = Math.sin(angle);
      p.vx += tx * t.vxBoost * hScale;
      p.vy += ty * t.vxBoost * 0.4 * hScale;
      p.vx += nx * t.boost * 0.15 * hScale;
      p.vy += ny * t.boost * vScale;
      p.x += nx * 6;
      p.y += ny * 6;
    }
  }
}

function resolveWalls(stage, p) {
  for (const wall of stage.walls) {
    const closestX = Math.max(wall.x, Math.min(p.x, wall.x + wall.w));
    const closestY = Math.max(wall.y, Math.min(p.y, wall.y + wall.h));
    const dx = p.x - closestX;
    const dy = p.y - closestY;
    const distSq = dx * dx + dy * dy;
    if (distSq < p.radius * p.radius) {
      const dist = Math.sqrt(distSq) || 0.001;
      const nx = dx / dist;
      const ny = dy / dist;
      const push = p.radius - dist;
      p.x += nx * push;
      p.y += ny * push;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        p.vx -= vn * nx;
        p.vy -= vn * ny;
      }
    }
  }
}

function step(dt) {
  const stage = state.stages[state.currentStageIndex];
  const p = state.player;
  state.lockedAnchor = findClosestAnchor();

  // クリア演出中は短時間のスローモーションを優先し、判定を停止する
  if (state.clearSequence && getConfig("features.clearCinematic", true)) {
    const elapsed = performance.now() - state.clearSequence.startedAt;
    const slow = getConfig("clear.slowMotionScale", 0.25);
    p.vy += 980 * dt * slow * 0.15;
    p.x += p.vx * dt * slow;
    p.y += p.vy * dt * slow;
    p.vx *= 0.992;
    p.vy *= 0.992;
    state.cameraX = Math.max(0, p.x - 220);
    if (elapsed >= state.clearSequence.durationMs) {
      const next = state.clearSequence.nextStageIndex;
      state.clearSequence = null;
      if (next != null) {
        startStage(next);
      } else {
        state.running = false;
        setScreen("select");
      }
    }
    return;
  }

  p.vy += 980 * dt;

  if (state.hookedAnchor) {
    const ax = state.hookedAnchor.x;
    const ay = state.hookedAnchor.y;
    const dx = p.x - ax;
    const dy = p.y - ay;
    let dist = Math.hypot(dx, dy) || 0.001;
    const nx = dx / dist;
    const ny = dy / dist;

    const radialSpeed = p.vx * nx + p.vy * ny;
    if (radialSpeed > 0) {
      p.vx -= radialSpeed * nx;
      p.vy -= radialSpeed * ny;
    }

    dist = Math.max(dist, state.player.ropeLength);
    p.x = ax + nx * state.player.ropeLength;
    p.y = ay + ny * state.player.ropeLength;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  resolveTrampolines(stage, p);
  resolveWalls(stage, p);

  if (p.y > stage.failZoneY + stage.failMargin) {
    failAndRetry();
    return;
  }

  if (p.x >= stage.goalLineX) {
    clearStage();
    return;
  }

  state.cameraX = Math.max(0, p.x - 220);
  state.elapsedSec = (performance.now() - state.stageStartMs) / 1000;
  timerEl.textContent = `${state.elapsedSec.toFixed(3)}s`;
}

function draw() {
  const stage = state.stages[state.currentStageIndex];
  const p = state.player;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(-state.cameraX, 0);

  ctx.strokeStyle = "#2a3d66";
  ctx.lineWidth = 2;
  for (let x = 0; x < stage.width; x += 100) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  ctx.fillStyle = "#a7cbff";
  for (const anchor of stage.anchors) {
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "#68ff8f";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(stage.goalLineX, 8);
  ctx.lineTo(stage.goalLineX, canvas.height - 8);
  ctx.stroke();

  ctx.fillStyle = "#8bf5a4";
  for (const t of stage.trampolines) {
    const tSec = (performance.now() - state.stageStartMs) / 1000;
    const moveOffset = t.moveAmp ? Math.sin(tSec * t.moveSpeed + t.phase) * t.moveAmp : 0;
    const cx = t.x + t.w / 2;
    const cy = t.y + moveOffset + t.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t.angle || 0);
    ctx.fillRect(-t.w / 2, -t.h / 2, t.w, t.h);
    ctx.restore();
  }

  ctx.fillStyle = "#7ca0ff";
  for (const wall of stage.walls) {
    ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
  }

  ctx.fillStyle = "rgba(255,80,80,0.22)";
  ctx.fillRect(0, stage.failZoneY, stage.width, canvas.height - stage.failZoneY);

  if (state.hookedAnchor) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(state.hookedAnchor.x, state.hookedAnchor.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  if (state.lockedAnchor && !state.hookedAnchor) {
    ctx.strokeStyle = "#f9ff7f";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(state.lockedAnchor.x, state.lockedAnchor.y, 13, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawStickman(p.x, p.y, p.radius);

  ctx.restore();

  if (state.clearSequence) {
    const m = state.clearSequence.metrics;
    ctx.fillStyle = "rgba(5,10,20,0.42)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = "center";
    ctx.fillStyle = "#f8ff9c";
    ctx.font = "bold 70px sans-serif";
    ctx.fillText("CLEAR!", canvas.width / 2, canvas.height * 0.38);
    ctx.fillStyle = "#ffffff";
    ctx.font = "24px sans-serif";
    ctx.fillText(`TIME ${m.timeSec.toFixed(3)}s`, canvas.width / 2, canvas.height * 0.47);
    if (state.clearSequence.showEvaluation) {
      ctx.font = "19px sans-serif";
      ctx.fillText(
        `速度 ${m.speed} | 角度 ${m.angleDeg}° | 高さ ${m.height} | タップ ${m.taps}`,
        canvas.width / 2,
        canvas.height * 0.56
      );
    }
  }
}

function drawStickman(x, y, r) {
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.arc(x, y - r * 1.3, r * 0.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.7);
  ctx.lineTo(x, y + r * 0.9);
  ctx.moveTo(x, y - r * 0.1);
  ctx.lineTo(x - r, y + r * 0.4);
  ctx.moveTo(x, y - r * 0.1);
  ctx.lineTo(x + r, y + r * 0.4);
  ctx.moveTo(x, y + r * 0.9);
  ctx.lineTo(x - r * 0.8, y + r * 1.8);
  ctx.moveTo(x, y + r * 0.9);
  ctx.lineTo(x + r * 0.8, y + r * 1.8);
  ctx.stroke();
}

function loop(ts) {
  if (!state.running) return;
  if (!state.lastTs) state.lastTs = ts;
  let delta = (ts - state.lastTs) / 1000;
  delta = Math.min(delta, 0.05);
  state.lastTs = ts;

  state.accumulator += delta;
  const fixed = 1 / 120;
  while (state.accumulator >= fixed) {
    step(fixed);
    state.accumulator -= fixed;
    if (!state.running) break;
  }

  if (state.running) {
    draw();
    requestAnimationFrame(loop);
  }
}

function playFailBeep() {
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "square";
  osc.frequency.value = 180;
  gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.13);
}

function playHookSe() {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(520, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.08);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.09);
}

function playUnhookSe(speed) {
  if (audioCtx.state === "suspended") audioCtx.resume();
  const clamped = Math.max(120, Math.min(1200, speed));
  const freq = 280 + (clamped - 120) * 0.42;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.02, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.1);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.11);
}

function onPress(event) {
  event.preventDefault();
  if (!state.running) return;
  if (state.clearSequence) return;
  state.pointerDown = true;
  state.tapCount += 1;
  const before = state.hookedAnchor;
  hook();
  if (!before && state.hookedAnchor) {
    playHookSe();
  }
}

function onRelease(event) {
  event.preventDefault();
  state.pointerDown = false;
  if (state.hookedAnchor && state.player) {
    const speed = Math.hypot(state.player.vx, state.player.vy);
    playUnhookSe(speed);
  }
  unhook();
}

function bindInput() {
  gameScreenEl.addEventListener("pointerdown", onPress);
  window.addEventListener("pointerup", onRelease);
  window.addEventListener("pointercancel", onRelease);
  gameScreenEl.addEventListener("touchstart", (event) => {
    if (screens.game.classList.contains("active")) {
      event.preventDefault();
    }
  }, { passive: false });
  gameScreenEl.addEventListener("dblclick", (event) => event.preventDefault());
  document.addEventListener("gesturestart", (event) => event.preventDefault());
}

function boot() {
  document.getElementById("startBtn").addEventListener("click", () => startStage(0));
  document.getElementById("selectBtn").addEventListener("click", () => {
    buildStageGrid();
    setScreen("select");
  });
  document.getElementById("backBtn").addEventListener("click", () => setScreen("title"));
  document.getElementById("menuBtn").addEventListener("click", () => {
    state.running = false;
    setScreen("title");
    updateStatsUI();
  });

  bindInput();
  updateStatsUI();
  buildStageGrid();
  setScreen("title");

  const start = () => {
    if (!state.running) return;
    requestAnimationFrame(loop);
  };
  setInterval(start, 200);
}

loadConfig().finally(() => boot());
