/**
 * Tetris visualization — AI plays Tetris, pieces hard-drop on each detected beat
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';

const COLS = 10;
const ROWS = 20;

// Type index: 0=I, 1=O, 2=T, 3=S, 4=Z, 5=J, 6=L
const PIECE_SHAPES: [number, number][][] = [
  [[0,0],[0,1],[0,2],[0,3]],   // I
  [[0,0],[0,1],[1,0],[1,1]],   // O
  [[0,1],[1,0],[1,1],[1,2]],   // T
  [[0,1],[0,2],[1,0],[1,1]],   // S
  [[0,0],[0,1],[1,1],[1,2]],   // Z
  [[0,0],[1,0],[1,1],[1,2]],   // J
  [[0,2],[1,0],[1,1],[1,2]],   // L
];
const PIECE_SIZES: number[] = [4, 2, 3, 3, 3, 3, 3];
const PIECE_HUES: number[] = [180, 60, 300, 120, 0, 210, 30];

function rotateCW(cells: [number, number][], size: number): [number, number][] {
  return cells.map(([r, c]) => [c, size - 1 - r] as [number, number]);
}

// Precompute all 4 rotations for all 7 piece types
const ALL_ROTATIONS: [number, number][][][] = PIECE_SHAPES.map((shape, i) => {
  const size = PIECE_SIZES[i];
  const rots: [number, number][][] = [shape];
  for (let r = 1; r < 4; r++) {
    rots.push(rotateCW(rots[r - 1], size));
  }
  return rots;
});

// Module-scoped game state
let board: number[][];
let currentType = 0;
let currentRot = 0;
let currentCol = 0;   // integer — logical position (= targetCol)
let displayCol = 0;   // float — animated toward currentCol
let nextType = 0;
let targetCol = 0;
let targetRot = 0;
let score = 0;
let linesCleared = 0;
let clearingRows: number[] = [];
let clearTimer = 0;
let lastBeatIndex = -1;
let lastBeatGroupIndex = -1;
let autoDropTimer = 0;
let initialized = false;

function emptyBoard(): number[][] {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

function collides(testBoard: number[][], cells: [number, number][], row: number, col: number): boolean {
  for (const [dr, dc] of cells) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
    if (testBoard[r][c] !== 0) return true;
  }
  return false;
}

function findDropRow(testBoard: number[][], cells: [number, number][], col: number): number {
  let row = 0;
  while (row + 1 < ROWS && !collides(testBoard, cells, row + 1, col)) {
    row++;
  }
  return row;
}

function placeOnBoard(testBoard: number[][], cells: [number, number][], row: number, col: number, type: number): void {
  for (const [dr, dc] of cells) {
    testBoard[row + dr][col + dc] = type + 1;
  }
}

// El-Tetris evaluation
function evaluateBoard(testBoard: number[][]): number {
  const colHeights: number[] = new Array(COLS).fill(0);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (testBoard[r][c] !== 0) {
        colHeights[c] = ROWS - r;
        break;
      }
    }
  }
  const aggregateHeight = colHeights.reduce((s, h) => s + h, 0);

  let completedLines = 0;
  for (let r = 0; r < ROWS; r++) {
    if (testBoard[r].every(c => c !== 0)) completedLines++;
  }

  let holes = 0;
  for (let c = 0; c < COLS; c++) {
    let foundBlock = false;
    for (let r = 0; r < ROWS; r++) {
      if (testBoard[r][c] !== 0) foundBlock = true;
      else if (foundBlock) holes++;
    }
  }

  let bumpiness = 0;
  for (let c = 0; c < COLS - 1; c++) {
    bumpiness += Math.abs(colHeights[c] - colHeights[c + 1]);
  }

  return (
    -0.510066 * aggregateHeight +
     0.760666 * completedLines -
     0.35663  * holes -
     0.184483 * bumpiness
  );
}

function findBestPlacement(type: number): [number, number] {
  let bestScore = -Infinity;
  let bestRot = 0;
  let bestCol = 3;

  for (let rot = 0; rot < 4; rot++) {
    const cells = ALL_ROTATIONS[type][rot];
    const maxDc = cells.reduce((mx, [, c]) => Math.max(mx, c), 0);
    const minDc = cells.reduce((mn, [, c]) => Math.min(mn, c), Infinity);
    const maxValidCol = COLS - 1 - maxDc;
    const minValidCol = -minDc;

    for (let col = minValidCol; col <= maxValidCol; col++) {
      if (collides(board, cells, 0, col)) continue;
      const dropRow = findDropRow(board, cells, col);
      const testBoard = board.map(row => [...row]);
      placeOnBoard(testBoard, cells, dropRow, col, type);
      const s = evaluateBoard(testBoard);
      if (s > bestScore) {
        bestScore = s;
        bestRot = rot;
        bestCol = col;
      }
    }
  }

  return [bestRot, bestCol];
}

function hardDrop(): void {
  // Snap visual display to target before placing
  currentRot = targetRot;
  currentCol = targetCol;
  displayCol = targetCol;

  const cells = ALL_ROTATIONS[currentType][currentRot];
  const dropRow = findDropRow(board, cells, currentCol);
  placeOnBoard(board, cells, dropRow, currentCol, currentType);

  // Check for completed rows
  clearingRows = [];
  for (let r = 0; r < ROWS; r++) {
    if (board[r].every(c => c !== 0)) clearingRows.push(r);
  }

  if (clearingRows.length > 0) {
    clearTimer = 200;
    const pts = [0, 100, 300, 500, 800];
    score += pts[Math.min(clearingRows.length, 4)];
    linesCleared += clearingRows.length;
  }

  // Spawn next piece
  currentType = nextType;
  nextType = Math.floor(Math.random() * 7);
  displayCol = 3;

  // Board full — reset
  if (collides(board, ALL_ROTATIONS[currentType][0], 0, 3)) {
    board = emptyBoard();
    score = 0;
    linesCleared = 0;
    clearingRows = [];
    clearTimer = 0;
  }

  // AI: compute best placement for new piece and snap rotation/col
  [targetRot, targetCol] = findBestPlacement(currentType);
  currentRot = targetRot;
  currentCol = targetCol;
  // displayCol stays at 3 and animates toward currentCol
}

function clearCompletedRows(): void {
  if (clearingRows.length === 0) return;
  const sorted = [...clearingRows].sort((a, b) => b - a);
  for (const r of sorted) {
    board.splice(r, 1);
    board.unshift(new Array(COLS).fill(0));
  }
  clearingRows = [];
}

function initTetris(): void {
  board = emptyBoard();
  currentType = Math.floor(Math.random() * 7);
  nextType = Math.floor(Math.random() * 7);
  currentRot = 0;
  currentCol = 3;
  displayCol = 3;
  score = 0;
  linesCleared = 0;
  clearingRows = [];
  clearTimer = 0;
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
  autoDropTimer = 0;
  [targetRot, targetCol] = findBestPlacement(currentType);
  currentRot = targetRot;
  currentCol = targetCol;
}

export function resetTetris(): void {
  initialized = false;
}

export function drawTetris(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;

  if (!initialized) {
    initTetris();
    initialized = true;
  }

  // Line-clear flash timer
  if (clearTimer > 0) {
    clearTimer -= p.deltaTime;
    if (clearTimer <= 0) {
      clearTimer = 0;
      clearCompletedRows();
    }
  }

  // Beat detection — same pattern as runners/highway
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      const beatsPerDrop = Math.pow(2, config.beatDivision - 1);
      const group = Math.floor(beatIdx / beatsPerDrop);
      if (group !== lastBeatGroupIndex) {
        lastBeatGroupIndex = group;
        if (clearTimer <= 0) hardDrop();
      }
    }
  } else {
    autoDropTimer += p.deltaTime;
    if (autoDropTimer >= 2000) {
      autoDropTimer = 0;
      if (clearTimer <= 0) hardDrop();
    }
  }

  // Animate displayCol toward currentCol at a fixed speed
  const moveSpeed = 20 * dt;
  const diff = currentCol - displayCol;
  if (Math.abs(diff) <= moveSpeed) {
    displayCol = currentCol;
  } else {
    displayCol += Math.sign(diff) * moveSpeed;
  }

  // Layout
  const cellSize = Math.min(
    Math.floor(p.height * 0.85 / ROWS),
    Math.floor(p.width * 0.38 / COLS)
  );
  const boardW = COLS * cellSize;
  const boardH = ROWS * cellSize;
  const boardX = p.width / 2 - boardW / 2 - cellSize * 3;
  const boardY = (p.height - boardH) / 2;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Board background
  (p as any).fill(0, 0, 8, 100);
  p.noStroke();
  p.rect(boardX, boardY, boardW, boardH);

  // Grid lines
  (p as any).stroke(0, 0, 15, 100);
  p.strokeWeight(0.5);
  for (let c = 1; c < COLS; c++) {
    p.line(boardX + c * cellSize, boardY, boardX + c * cellSize, boardY + boardH);
  }
  for (let r = 1; r < ROWS; r++) {
    p.line(boardX, boardY + r * cellSize, boardX + boardW, boardY + r * cellSize);
  }

  // Board border
  p.noFill();
  (p as any).stroke(0, 0, 40, 100);
  p.strokeWeight(2);
  p.rect(boardX, boardY, boardW, boardH);

  // Placed cells
  p.noStroke();
  for (let r = 0; r < ROWS; r++) {
    const isClearing = clearTimer > 0 && clearingRows.includes(r);
    for (let c = 0; c < COLS; c++) {
      const cell = board[r][c];
      if (cell === 0) continue;
      const colorIdx = cell - 1;
      if (isClearing) {
        (p as any).fill(0, 0, 100, 100);
      } else {
        const hue = PIECE_HUES[colorIdx];
        const bandData = audioState.smoothedBands[colorIdx % 7];
        const bandAmp = bandData
          ? Array.from(bandData).reduce((a, b) => a + b, 0) / bandData.length
          : 0;
        (p as any).fill(hue, 80, 70 + bandAmp * 30, 100);
      }
      p.rect(boardX + c * cellSize + 1, boardY + r * cellSize + 1, cellSize - 2, cellSize - 2);
    }
  }

  // Ghost piece and current piece (hidden during line-clear flash)
  if (clearTimer <= 0) {
    const cells = ALL_ROTATIONS[currentType][currentRot];
    const ghostRow = findDropRow(board, cells, currentCol);
    const hue = PIECE_HUES[currentType];

    // Ghost
    (p as any).fill(hue, 80, 30, 40);
    p.noStroke();
    for (const [dr, dc] of cells) {
      const gr = ghostRow + dr;
      const gc = currentCol + dc;
      if (gr >= 0 && gr < ROWS && gc >= 0 && gc < COLS) {
        p.rect(boardX + gc * cellSize + 1, boardY + gr * cellSize + 1, cellSize - 2, cellSize - 2);
      }
    }

    // Current piece (animated displayCol)
    (p as any).fill(hue, 90, 90, 100);
    p.noStroke();
    for (const [dr, dc] of cells) {
      const pr = dr;
      const pc = displayCol + dc;
      p.rect(boardX + pc * cellSize + 1, boardY + pr * cellSize + 1, cellSize - 2, cellSize - 2);
    }
  }

  // Side panel
  const panelX = boardX + boardW + cellSize;
  const panelY = boardY;

  (p as any).fill(0, 0, 80, 100);
  p.noStroke();
  (p as any).textAlign(p['LEFT']);
  (p as any).textSize(cellSize * 0.7);
  (p as any).text('NEXT', panelX, panelY + cellSize * 0.8);

  // Next piece preview
  const previewCells = ALL_ROTATIONS[nextType][0];
  (p as any).fill(PIECE_HUES[nextType], 80, 80, 100);
  p.noStroke();
  for (const [dr, dc] of previewCells) {
    p.rect(
      panelX + dc * cellSize + 1,
      panelY + cellSize + dr * cellSize + 1,
      cellSize - 2,
      cellSize - 2
    );
  }

  const statsY = panelY + cellSize * 6;
  (p as any).fill(0, 0, 70, 100);
  (p as any).textSize(cellSize * 0.6);
  (p as any).text('SCORE', panelX, statsY);
  (p as any).fill(0, 0, 100, 100);
  (p as any).textSize(cellSize * 0.75);
  (p as any).text(String(score), panelX, statsY + cellSize * 0.9);

  (p as any).fill(0, 0, 70, 100);
  (p as any).textSize(cellSize * 0.6);
  (p as any).text('LINES', panelX, statsY + cellSize * 2.2);
  (p as any).fill(0, 0, 100, 100);
  (p as any).textSize(cellSize * 0.75);
  (p as any).text(String(linesCleared), panelX, statsY + cellSize * 3.1);

  // Reset color mode
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
