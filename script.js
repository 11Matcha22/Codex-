const STAGE_COUNT = 50;
const STORAGE_KEY = "hook_swing_progress_v1";

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

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const state = {
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

function makeStages(count) {
  const stages = [];
  for (let i = 1; i <= count; i += 1) {
    const anchors = [];
    const baseX = 280;
    const spacing = 245 - Math.min(90, i * 1.3);
    const waves = 3 + (i % 3);
    for (let a = 0; a < waves + 3; a += 1) {
      const x = baseX + a * spacing;
      const y = 210 + Math.sin((a + i) * 0.9) * (80 + (i % 6) * 5);
      anchors.push({ x, y });
    }
    const failZoneY = 690;
    const goalX = anchors[anchors.length - 1].x + 220;
    const trampolines = i % 5 === 0 ? [{ x: anchors[1].x + 70, y: 620, w: 90, h: 14, boost: 420 }] : [];
    stages.push({
      id: i,
      width: goalX + 220,
      anchors,
      failZoneY,
      failMargin: 120,
      goalLineX: goalX,
      trampolines,
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
  state.running = false;
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
  setScreen("select");
}

function findClosestAnchor(maxDist = 180) {
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
  state.player.ropeLength = Math.hypot(anchor.x - state.player.x, anchor.y - state.player.y);
}

function unhook() {
  state.hookedAnchor = null;
}

function step(dt) {
  const stage = state.stages[state.currentStageIndex];
  const p = state.player;

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

  for (const t of stage.trampolines) {
    if (p.x > t.x && p.x < t.x + t.w && p.y + p.radius >= t.y && p.y + p.radius <= t.y + t.h + 14 && p.vy > 0) {
      p.y = t.y - p.radius;
      p.vy = -t.boost;
    }
  }

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
  ctx.moveTo(stage.goalLineX, 80);
  ctx.lineTo(stage.goalLineX, stage.failZoneY - 120);
  ctx.stroke();

  ctx.fillStyle = "#8bf5a4";
  for (const t of stage.trampolines) {
    ctx.fillRect(t.x, t.y, t.w, t.h);
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

  drawStickman(p.x, p.y, p.radius);

  ctx.restore();
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

function onPress(event) {
  event.preventDefault();
  if (!state.running) return;
  state.pointerDown = true;
  hook();
}

function onRelease(event) {
  event.preventDefault();
  state.pointerDown = false;
  unhook();
}

function bindInput() {
  canvas.addEventListener("pointerdown", onPress);
  window.addEventListener("pointerup", onRelease);
  window.addEventListener("pointercancel", onRelease);
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

boot();
