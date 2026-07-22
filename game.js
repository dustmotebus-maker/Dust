(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const TILE = 25;
  const COLS = 19;
  const ROWS = 21;
  const WALL = 0, PELLET = 1, POWER = 2, EMPTY = 3;

  const STEP_MS = 1000 / 60;
  // Alignment tolerance must be smaller than every speed below, so a tile's
  // exact-multiple landing is the only position that ever reads as "aligned"
  // (never the position one step after departing the previous tile).
  const ALIGN_EPS = 0.6;

  // Speeds are always TILE / (integer steps-per-tile) so an entity lands
  // exactly on a tile boundary every time, with no cumulative drift.
  const PACMAN_BASE_STEPS = 10;
  const GHOST_BASE_STEPS = 12;
  const FRIGHTENED_STEPS = 18;
  const EATEN_SPEED = TILE / 6;

  const DOOR_TILE = { row: 9, col: 9 };
  const HOUSE_TILES = [
    { row: 10, col: 8 }, { row: 10, col: 9 }, { row: 10, col: 10 },
    { row: 11, col: 8 }, { row: 11, col: 9 }, { row: 11, col: 10 },
  ];
  const PACMAN_START = { row: 16, col: 9 };
  const TUNNEL_ROW = 10;

  const DIRS = {
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
  };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  const MODE_SCHEDULE = [
    { mode: 'scatter', duration: 7 },
    { mode: 'chase', duration: 20 },
    { mode: 'scatter', duration: 7 },
    { mode: 'chase', duration: 20 },
    { mode: 'scatter', duration: 5 },
    { mode: 'chase', duration: 20 },
    { mode: 'scatter', duration: 5 },
    { mode: 'chase', duration: Infinity },
  ];

  const GHOST_DEFS = [
    { name: 'blinky', color: '#ff0000', scatter: { row: 0, col: COLS - 1 } },
    { name: 'pinky', color: '#ffb8de', scatter: { row: 0, col: 0 } },
    { name: 'inky', color: '#00ffff', scatter: { row: ROWS - 1, col: COLS - 1 } },
    { name: 'clyde', color: '#ffb852', scatter: { row: ROWS - 1, col: 0 } },
  ];

  // ---------------------------------------------------------------------
  // Maze generation (lattice maze + carved ghost house / tunnel / corners)
  // ---------------------------------------------------------------------
  function generateMaze() {
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
          row.push(WALL);
        } else if (r % 2 === 1 && c % 2 === 1) {
          row.push(WALL);
        } else {
          row.push(PELLET);
        }
      }
      grid.push(row);
    }

    grid[TUNNEL_ROW][0] = EMPTY;
    grid[TUNNEL_ROW][COLS - 1] = EMPTY;

    for (let c = 8; c <= 10; c++) {
      grid[10][c] = EMPTY;
      grid[11][c] = EMPTY;
    }
    grid[9][8] = WALL;
    grid[9][9] = EMPTY;
    grid[9][10] = WALL;
    grid[12][8] = WALL;
    grid[12][9] = WALL;
    grid[12][10] = WALL;
    grid[10][7] = WALL;
    grid[11][7] = WALL;
    grid[10][11] = WALL;
    grid[11][11] = WALL;

    const corners = [[1, 1], [1, COLS - 2], [ROWS - 2, 1], [ROWS - 2, COLS - 2]];
    for (const [r, c] of corners) grid[r][c] = POWER;

    grid[PACMAN_START.row][PACMAN_START.col] = EMPTY;

    return grid;
  }

  function countPellets(grid) {
    let n = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] === PELLET || grid[r][c] === POWER) n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------
  // Canvas / DOM setup
  // ---------------------------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const highScoreEl = document.getElementById('highscore');
  const levelEl = document.getElementById('level');
  const livesEl = document.getElementById('lives');
  const overlay = document.getElementById('overlay');
  const overlayMessage = document.getElementById('overlay-message');
  const startBtn = document.getElementById('start-btn');

  const HIGH_SCORE_KEY = 'pacman-high-score';

  // ---------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------
  let grid, pelletsRemaining;
  let score = 0, highScore = Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
  let lives = 3, level = 1;
  let ghostEatCombo = 0;
  let frightenedTimer = 0;
  let modeIndex = 0, modeTimer = MODE_SCHEDULE[0].duration;
  let state = 'idle'; // idle | ready | playing | dying | levelComplete | gameOver | paused
  let stateTimer = 0;
  let animTimer = 0;
  let pacman, ghosts;

  highScoreEl.textContent = highScore;

  function tileBlocked(row, col) {
    if (row < 0 || row >= ROWS) return true;
    let c = col;
    if (row === TUNNEL_ROW) {
      if (c < 0) c = COLS - 1;
      if (c >= COLS) c = 0;
    } else if (c < 0 || c >= COLS) {
      return true;
    }
    return grid[row][c] === WALL;
  }

  function wrapCol(col) {
    if (col < 0) return COLS - 1;
    if (col >= COLS) return 0;
    return col;
  }

  function createPacman() {
    return {
      x: PACMAN_START.col * TILE,
      y: PACMAN_START.row * TILE,
      dir: 'left',
      nextDir: 'left',
      moving: false,
      mouthPhase: 0,
    };
  }

  function createGhosts() {
    return GHOST_DEFS.map((def, i) => {
      const home = HOUSE_TILES[i % HOUSE_TILES.length];
      return {
        name: def.name,
        color: def.color,
        scatter: def.scatter,
        x: home.col * TILE,
        y: home.row * TILE,
        homeRow: home.row,
        homeCol: home.col,
        dir: 'up',
        mode: 'house',
        houseTimer: i * 40, // stagger release
        frightFlash: false,
      };
    });
  }

  function resetPositions() {
    pacman = createPacman();
    ghosts = createGhosts();
    modeIndex = 0;
    modeTimer = MODE_SCHEDULE[0].duration;
    frightenedTimer = 0;
    ghostEatCombo = 0;
  }

  function newGame() {
    grid = generateMaze();
    pelletsRemaining = countPellets(grid);
    score = 0;
    lives = 3;
    level = 1;
    resetPositions();
    updateHud();
    state = 'ready';
    stateTimer = 1.2;
  }

  function nextLevel() {
    grid = generateMaze();
    pelletsRemaining = countPellets(grid);
    level += 1;
    resetPositions();
    updateHud();
    state = 'ready';
    stateTimer = 1.2;
  }

  function updateHud() {
    scoreEl.textContent = score;
    levelEl.textContent = level;
    livesEl.textContent = lives;
    if (score > highScore) {
      highScore = score;
      highScoreEl.textContent = highScore;
      localStorage.setItem(HIGH_SCORE_KEY, String(highScore));
    }
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  const KEY_MAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
  };

  function setDirection(dir) {
    if (!pacman) return;
    pacman.nextDir = dir;
  }

  window.addEventListener('keydown', (e) => {
    const dir = KEY_MAP[e.code];
    if (dir) {
      e.preventDefault();
      setDirection(dir);
    } else if (e.code === 'KeyP') {
      if (state === 'playing') { state = 'paused'; }
      else if (state === 'paused') { state = 'playing'; }
    }
  });

  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    document.body.classList.add('has-touch');
  }

  function bindTouch(id, dir) {
    const el = document.getElementById(id);
    const handler = (e) => { e.preventDefault(); setDirection(dir); };
    el.addEventListener('touchstart', handler, { passive: false });
    el.addEventListener('mousedown', handler);
  }
  bindTouch('btn-up', 'up');
  bindTouch('btn-down', 'down');
  bindTouch('btn-left', 'left');
  bindTouch('btn-right', 'right');

  startBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
    newGame();
  });

  // ---------------------------------------------------------------------
  // Movement helpers
  // ---------------------------------------------------------------------
  function isAligned(px, py) {
    const rx = ((px % TILE) + TILE) % TILE;
    const ry = ((py % TILE) + TILE) % TILE;
    return (rx < ALIGN_EPS || rx > TILE - ALIGN_EPS) &&
           (ry < ALIGN_EPS || ry > TILE - ALIGN_EPS);
  }

  function snap(entity) {
    entity.x = Math.round(entity.x / TILE) * TILE;
    entity.y = Math.round(entity.y / TILE) * TILE;
  }

  function tileOf(entity) {
    return { row: Math.round(entity.y / TILE), col: Math.round(entity.x / TILE) };
  }

  function movePacman(speed) {
    if (isAligned(pacman.x, pacman.y)) {
      snap(pacman);
      const { row, col } = tileOf(pacman);
      const wantDir = DIRS[pacman.nextDir];
      if (wantDir && !tileBlocked(row + wantDir.dy, col + wantDir.dx)) {
        pacman.dir = pacman.nextDir;
      }
      const curDir = DIRS[pacman.dir];
      if (tileBlocked(row + curDir.dy, col + curDir.dx)) {
        pacman.moving = false;
      } else {
        pacman.moving = true;
      }
    }
    if (pacman.moving) {
      const d = DIRS[pacman.dir];
      pacman.x += d.dx * speed;
      pacman.y += d.dy * speed;
      if (pacman.y === TUNNEL_ROW * TILE) {
        if (pacman.x < 0) pacman.x = (COLS - 1) * TILE;
        if (pacman.x > (COLS - 1) * TILE) pacman.x = 0;
      }
    }
  }

  function ghostTarget(ghost) {
    if (ghost.mode === 'frightened') return null;
    if (ghost.mode === 'eaten') return DOOR_TILE;
    if (ghost.mode === 'house') return DOOR_TILE;
    if (ghost.mode === 'scatter') return ghost.scatter;

    const pTile = tileOf(pacman);
    const pDir = DIRS[pacman.dir];

    switch (ghost.name) {
      case 'blinky':
        return pTile;
      case 'pinky':
        return { row: pTile.row + pDir.dy * 4, col: pTile.col + pDir.dx * 4 };
      case 'inky': {
        const blinky = ghosts.find((g) => g.name === 'blinky');
        const bTile = tileOf(blinky);
        const aheadRow = pTile.row + pDir.dy * 2;
        const aheadCol = pTile.col + pDir.dx * 2;
        return { row: aheadRow + (aheadRow - bTile.row), col: aheadCol + (aheadCol - bTile.col) };
      }
      case 'clyde': {
        const gTile = tileOf(ghost);
        const dist = Math.hypot(gTile.row - pTile.row, gTile.col - pTile.col);
        return dist > 8 ? pTile : ghost.scatter;
      }
      default:
        return pTile;
    }
  }

  function chooseGhostDirection(ghost) {
    const { row, col } = tileOf(ghost);
    const target = ghostTarget(ghost);
    const options = [];
    for (const name of Object.keys(DIRS)) {
      if (OPPOSITE[ghost.dir] === name && ghost.canReverse !== true) continue;
      const d = DIRS[name];
      const nr = row + d.dy;
      const nc = col + d.dx;
      if (tileBlocked(nr, nc)) continue;
      options.push({ name, row: nr, col: nc });
    }
    if (options.length === 0) {
      return OPPOSITE[ghost.dir];
    }
    if (ghost.mode === 'frightened') {
      return options[Math.floor(Math.random() * options.length)].name;
    }
    let best = options[0];
    let bestDist = Infinity;
    for (const opt of options) {
      const dist = (opt.row - target.row) ** 2 + (opt.col - target.col) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = opt;
      }
    }
    return best.name;
  }

  function moveGhost(ghost, speed) {
    if (ghost.mode === 'house') {
      ghost.houseTimer -= 1;
      // gentle bob while waiting
      ghost.y += Math.sin(animTimer * 4 + ghost.homeCol) * 0.15;
      if (ghost.houseTimer <= 0) {
        snap(ghost);
        ghost.mode = currentScheduledMode();
        ghost.x = DOOR_TILE.col * TILE;
        ghost.y = DOOR_TILE.row * TILE;
        ghost.dir = 'up';
      }
      return;
    }

    if (isAligned(ghost.x, ghost.y)) {
      snap(ghost);
      const { row, col } = tileOf(ghost);

      if (ghost.mode === 'eaten' && row === DOOR_TILE.row && col === DOOR_TILE.col) {
        ghost.mode = currentScheduledMode();
      }

      const dirName = chooseGhostDirection(ghost);
      ghost.dir = dirName;
      ghost.canReverse = false;
    }
    const d = DIRS[ghost.dir];
    ghost.x += d.dx * speed;
    ghost.y += d.dy * speed;
    if (ghost.y === TUNNEL_ROW * TILE) {
      if (ghost.x < 0) ghost.x = (COLS - 1) * TILE;
      if (ghost.x > (COLS - 1) * TILE) ghost.x = 0;
    }
  }

  function currentScheduledMode() {
    return MODE_SCHEDULE[modeIndex].mode;
  }

  function forceGhostReversal() {
    for (const g of ghosts) {
      if (g.mode === 'scatter' || g.mode === 'chase') {
        g.canReverse = true;
        g.dir = OPPOSITE[g.dir];
      }
    }
  }

  // ---------------------------------------------------------------------
  // Core update
  // ---------------------------------------------------------------------
  function speedForSteps(baseSteps) {
    const steps = Math.max(baseSteps - Math.min(level - 1, 4), 6);
    return TILE / steps;
  }

  function updatePlaying(dt) {
    const pacSpeed = speedForSteps(PACMAN_BASE_STEPS);
    movePacman(pacSpeed);
    pacman.mouthPhase += dt * 10;

    // mode schedule ticking (frozen during frightened)
    if (frightenedTimer > 0) {
      frightenedTimer -= dt;
      if (frightenedTimer <= 0) {
        frightenedTimer = 0;
        for (const g of ghosts) {
          if (g.mode === 'frightened') g.mode = currentScheduledMode();
        }
      }
    } else {
      modeTimer -= dt;
      if (modeTimer <= 0 && modeIndex < MODE_SCHEDULE.length - 1) {
        modeIndex += 1;
        modeTimer = MODE_SCHEDULE[modeIndex].duration;
        forceGhostReversal();
        for (const g of ghosts) {
          if (g.mode === 'scatter' || g.mode === 'chase') g.mode = currentScheduledMode();
        }
      }
    }

    for (const g of ghosts) {
      let speed;
      if (g.mode === 'frightened') speed = speedForSteps(FRIGHTENED_STEPS);
      else if (g.mode === 'eaten') speed = EATEN_SPEED;
      else speed = speedForSteps(GHOST_BASE_STEPS);
      moveGhost(g, speed);
    }

    // Eat pellets
    const pTile = tileOf(pacman);
    if (isAligned(pacman.x, pacman.y)) {
      const cell = grid[pTile.row][pTile.col];
      if (cell === PELLET || cell === POWER) {
        grid[pTile.row][pTile.col] = EMPTY;
        pelletsRemaining -= 1;
        if (cell === PELLET) {
          score += 10;
        } else {
          score += 50;
          frightenedTimer = Math.max(2, 7 - (level - 1) * 0.4);
          ghostEatCombo = 0;
          for (const g of ghosts) {
            if (g.mode === 'scatter' || g.mode === 'chase') {
              g.mode = 'frightened';
              g.canReverse = true;
              g.dir = OPPOSITE[g.dir];
            }
          }
        }
        updateHud();
        if (pelletsRemaining <= 0) {
          state = 'levelComplete';
          stateTimer = 2;
          return;
        }
      }
    }

    // Collisions
    for (const g of ghosts) {
      if (g.mode === 'house') continue;
      const dist = Math.hypot(g.x - pacman.x, g.y - pacman.y);
      if (dist < TILE * 0.6) {
        if (g.mode === 'frightened') {
          ghostEatCombo += 1;
          score += 200 * Math.pow(2, Math.min(ghostEatCombo - 1, 3));
          g.mode = 'eaten';
          updateHud();
        } else if (g.mode === 'eaten') {
          // no effect
        } else {
          loseLife();
          return;
        }
      }
    }
  }

  function loseLife() {
    lives -= 1;
    updateHud();
    if (lives <= 0) {
      state = 'gameOver';
      stateTimer = 0;
      overlayMessage.innerHTML = `Game Over.<br>Final score: ${score}`;
      overlay.querySelector('h1').textContent = 'GAME OVER';
      startBtn.textContent = 'Play Again';
      overlay.classList.remove('hidden');
    } else {
      state = 'dying';
      stateTimer = 1.4;
    }
  }

  function update(dtMs) {
    const dt = dtMs / 1000;
    animTimer += dt;

    if (state === 'ready') {
      stateTimer -= dt;
      if (stateTimer <= 0) state = 'playing';
      return;
    }
    if (state === 'playing') {
      updatePlaying(dt);
      return;
    }
    if (state === 'dying') {
      stateTimer -= dt;
      if (stateTimer <= 0) {
        resetPositions();
        state = 'ready';
        stateTimer = 1.0;
      }
      return;
    }
    if (state === 'levelComplete') {
      stateTimer -= dt;
      if (stateTimer <= 0) nextLevel();
      return;
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function drawMaze() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = grid[r][c];
        const x = c * TILE, y = r * TILE;
        if (cell === WALL) {
          ctx.fillStyle = '#1a1aff';
          ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
        } else if (cell === PELLET) {
          ctx.fillStyle = '#ffd8a8';
          ctx.beginPath();
          ctx.arc(x + TILE / 2, y + TILE / 2, 2.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (cell === POWER) {
          const pulse = 3.5 + Math.sin(animTimer * 6) * 1.5;
          ctx.fillStyle = '#ffd8a8';
          ctx.beginPath();
          ctx.arc(x + TILE / 2, y + TILE / 2, pulse, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ghost house door
    ctx.fillStyle = '#ffb8de';
    ctx.fillRect(DOOR_TILE.col * TILE + 4, DOOR_TILE.row * TILE + TILE / 2 - 1, TILE - 8, 2);
  }

  function drawPacman() {
    const cx = pacman.x + TILE / 2;
    const cy = pacman.y + TILE / 2;
    const radius = TILE / 2 - 1;
    let mouthAngle = pacman.moving ? Math.abs(Math.sin(pacman.mouthPhase)) * 0.28 * Math.PI : 0.02;

    const angleForDir = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
    const base = angleForDir[pacman.dir] ?? 0;

    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, base + mouthAngle, base - mouthAngle + Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }

  function drawGhostBody(g, cx, cy) {
    const r = TILE / 2 - 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.lineTo(cx + r, cy + r);
    const waveCount = 4;
    for (let i = 0; i <= waveCount; i++) {
      const wx = cx + r - (2 * r * i) / waveCount;
      const wy = cy + r - (i % 2 === 0 ? 0 : 5);
      ctx.lineTo(wx, wy);
    }
    ctx.lineTo(cx - r, cy + r);
    ctx.closePath();
    ctx.fill();
  }

  function drawGhost(g) {
    if (g.mode === 'house' && g.houseTimer > 200) {
      // still fully hidden inside for a long stagger - draw anyway, looks fine
    }
    const cx = g.x + TILE / 2;
    const cy = g.y + TILE / 2;

    if (g.mode === 'eaten') {
      drawEyes(g, cx, cy);
      return;
    }

    let color = g.color;
    if (g.mode === 'frightened') {
      const flashing = frightenedTimer < 2 && Math.floor(animTimer * 6) % 2 === 0;
      color = flashing ? '#ffffff' : '#2121ff';
    }
    ctx.fillStyle = color;
    drawGhostBody(g, cx, cy);

    if (g.mode === 'frightened') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 6, cy - 2, 4, 2);
      ctx.fillRect(cx + 2, cy - 2, 4, 2);
    } else {
      drawEyes(g, cx, cy, true);
    }
  }

  function drawEyes(g, cx, cy, withPupilDir) {
    const eyeOffsetX = 5, eyeOffsetY = -3, eyeR = 3.2, pupilR = 1.6;
    const d = DIRS[g.dir] || { dx: 0, dy: 0 };
    [-1, 1].forEach((side) => {
      const ex = cx + side * eyeOffsetX;
      const ey = cy + eyeOffsetY;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1aff';
      ctx.beginPath();
      const px = withPupilDir ? ex + d.dx * 1.4 : ex;
      const py = withPupilDir ? ey + d.dy * 1.4 : ey;
      ctx.arc(px, py, pupilR, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function render() {
    drawMaze();
    if (pacman) {
      if (state !== 'dying') drawPacman();
      for (const g of ghosts) drawGhost(g);
    }

    if (state === 'ready') {
      drawCenteredText('READY!', '#ffd23f');
    } else if (state === 'levelComplete') {
      drawCenteredText('LEVEL COMPLETE', '#00ff88');
    } else if (state === 'paused') {
      drawCenteredText('PAUSED', '#fff');
    }
  }

  function drawCenteredText(text, color) {
    ctx.fillStyle = color;
    ctx.font = 'bold 20px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, PACMAN_START.row * TILE - 10);
  }

  // ---------------------------------------------------------------------
  // Main loop (fixed timestep)
  // ---------------------------------------------------------------------
  let lastTime = null;
  let accumulator = 0;

  function loop(timestamp) {
    if (lastTime === null) lastTime = timestamp;
    let delta = timestamp - lastTime;
    lastTime = timestamp;
    if (delta > 250) delta = 250; // clamp huge gaps (tab backgrounded)
    accumulator += delta;

    while (accumulator >= STEP_MS) {
      if (state !== 'paused' && state !== 'idle' && state !== 'gameOver') {
        update(STEP_MS);
      }
      accumulator -= STEP_MS;
    }

    if (state !== 'idle') render();
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();
