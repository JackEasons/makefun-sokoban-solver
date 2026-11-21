// Sokoban solver: push-optimal, room by room.
//
// A level is a hallway with one to four rooms off it, each room holding 3 or 4
// boxes and as many goals, and a box pushed out of a room into the hallway can
// never come back -- so each room is an independent problem and the level's
// push-optimal count is the sum of its rooms' optima. The solver:
//
//   1. cuts the hallway out of the floor (the hallway row's squares from which
//      no box can ever reach a goal), which leaves one part per room;
//   2. solves each room on its own with A* over pushes, the other rooms'
//      boxes standing as walls, the player walking on from where the last
//      room left it;
//   3. falls back to one A* over the whole level when the level is no set of
//      rooms, and to an empty answer when a search gives up.
//
// The room search is A* over pushes: a state is the boxes' squares and the
// player's reachable region (named by its lowest square). The estimate is the
// cheapest assignment of boxes to goals under the push distances of a box on
// its own, which never overestimates: one push moves one box one square along
// such a path. Two deadlocks are pruned, both safe: a box on a square from
// which no push sequence reaches any goal, and a frozen 2 x 2 block of walls
// and boxes with a box off its goal. Everything is budgeted by work, never
// by the clock, so two runs answer byte for byte alike.
//
// Node 22 runs this file as it is (erasable syntax only): node main.ts.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search expands before it gives up (work, not time). */
const ROOM_EXPANSIONS = 400_000;
/** The most states the whole-level fallback expands. */
const LEVEL_EXPANSIONS = 600_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For each goal, the fewest pushes a box alone needs from every square to
 * reach it, by pulling back from the goal: a box at x can have come from
 * y = x - d when y and the square behind it, y - d, are both open floor
 * (the player must have stood there to push it). -1 where unreachable.
 * live[i] is 1 when a box on square i can reach some goal at all.
 */
function pullDistances(level: Level): { dist: Int32Array; live: Uint8Array } {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = goals.length;
  const dist = new Int32Array(n * size).fill(-1);
  const live = new Uint8Array(size);
  const queue = new Int32Array(size);
  for (let gi = 0; gi < n; gi++) {
    const g = goals[gi]!;
    let head = 0;
    let tail = 0;
    queue[tail++] = g;
    dist[gi * size + g] = 0;
    while (head < tail) {
      const x = queue[head++]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (wall[y] || wall[y - d] || dist[gi * size + y] !== -1) continue;
        dist[gi * size + y] = dist[gi * size + x]! + 1;
        queue[tail++] = y;
      }
    }
  }
  for (let i = 0; i < size; i++) {
    for (let gi = 0; gi < n; gi++) {
      if (dist[gi * size + i] !== -1) {
        live[i] = 1;
        break;
      }
    }
  }
  return { dist, live };
}

/** The squares the player reaches from `from` with `occupied` in the way; the lowest reached square, and whether the region touches `touchRow` (-1: never). */
function regionOf(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
  touchRow: number,
): { low: number; touches: boolean } {
  const { w, wall } = level;
  let low = from;
  let touches = touchRow >= 0 && Math.floor(from / w) === touchRow;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || seen[q] === stamp) continue;
      seen[q] = stamp;
      stack[n++] = q;
      if (touchRow >= 0 && Math.floor(q / w) === touchRow) touches = true;
    }
  }
  return { low, touches };
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block: four squares of walls and boxes, a box among them off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The cheapest assignment of boxes to goals under the pull distances (exact for few boxes, by permutation), or Infinity when some box reaches no goal. */
function matchingEstimate(boxes: number[], dist: Int32Array, size: number, nGoals: number): number {
  const n = boxes.length;
  if (n === 0) return 0;
  const order = boxes.map((_, i) => i);
  let best = Infinity;
  // Heap's algorithm over box order, goals taken in order: every bijection.
  const perm = order.slice();
  const c = new Array<number>(n).fill(0);
  const costOf = (p: number[]): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = dist[p[i]! * size + boxes[i]!]!;
      if (d < 0) return Infinity;
      s += d;
      if (s >= best) return Infinity;
    }
    return s;
  };
  best = Math.min(best, costOf(perm));
  let i = 0;
  while (i < n) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
      const v = costOf(perm);
      if (v < best) best = v;
      c[i]!++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  void nGoals;
  return best;
}

/** A cheaper admissible estimate: each box to its nearest goal, goals shared. Used when there are too many boxes to match exactly. */
function nearestEstimate(boxes: number[], dist: Int32Array, size: number, nGoals: number): number {
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (let gi = 0; gi < nGoals; gi++) {
      const d = dist[gi * size + b]!;
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

/** A binary heap on [f, -g, seq]: lowest f first, deeper first on ties, insertion order last. Deterministic. */
class Heap {
  private a: { f: number; g: number; seq: number; s: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: { f: number; g: number; seq: number; s: number }): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[i]!, a[p]!)) {
        [a[i], a[p]] = [a[p]!, a[i]!];
        i = p;
      } else break;
    }
  }
  pop(): { f: number; g: number; seq: number; s: number } {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.less(a[c + 1]!, a[c]!)) c++;
        if (!Heap.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
  private static less(x: { f: number; g: number; seq: number }, y: { f: number; g: number; seq: number }): boolean {
    return x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.seq < y.seq)));
  }
}

/**
 * The push-optimal solution of `level` as { pushes, moves } (moves in LURD, a
 * capital letter marking a push), or null when the search gives up.
 * `exitRow`: a solved state counts only when the player's region reaches this
 * row (-1: any solved state counts). `maxExpansions` bounds the work.
 */
function searchPushOptimal(
  level: Level,
  exitRow: number,
  maxExpansions: number,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const nGoals = goals.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const { dist, live } = pullDistances(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const exact = level.boxes.length <= 6;
  const estimate = (boxes: number[]): number =>
    exact ? matchingEstimate(boxes, dist, size, nGoals) : nearestEstimate(boxes, dist, size, nGoals);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let markStamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const useNumericKey = level.boxes.length <= 5;
  const keyOf = (boxes: number[], low: number): string | number => {
    if (useNumericKey) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return `${low}|${boxes.join(',')}`;
  };

  // States in the order found: boxes, the player's square after the push that made them, parent, the push (from, to).
  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const statesG: number[] = [0];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const touchesExit: boolean[] = [false];
  const index = new Map<string | number, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const first = regionOf(level, occupied, level.player, seen, ++stamp, stack, exitRow);
  for (const b of level.boxes) occupied[b] = 0;
  touchesExit[0] = first.touches;
  index.set(keyOf(level.boxes, first.low), 0);

  const heap = new Heap();
  let seq = 0;
  const h0 = estimate(level.boxes);
  if (h0 === Infinity) return null;
  heap.push({ f: h0, g: 0, seq: seq++, s: 0 });

  let expanded = 0;
  let found = solved(level.boxes) && (exitRow < 0 || first.touches) ? 0 : -1;
  while (heap.size > 0 && found < 0) {
    const entry = heap.pop();
    const s = entry.s;
    // A stale entry: this state has since been reached in fewer pushes.
    if (entry.g !== statesG[s]) continue;
    const boxes = statesBoxes[s]!;
    const g = statesG[s]!;
    // A solved state counts when popped, not when generated: with a
    // consistent estimate, the first solved state popped is push-optimal.
    if (solved(boxes) && (exitRow < 0 || touchesExit[s])) {
      found = s;
      break;
    }
    if (expanded >= maxExpansions) return null;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    regionOf(level, occupied, statesPlayer[s]!, seen, ++stamp, stack, exitRow);
    const stampHere = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must stand on the far side, the target square must be
        // open floor and live, and the push must not freeze a 2 x 2 block.
        if (seen[b - d] !== stampHere || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const reg = regionOf(level, occupied, b, mark, ++markStamp, stack, exitRow);
        const key = keyOf(next, reg.low);
        occupied[t] = 0;
        occupied[b] = 1;
        const h = estimate(next);
        if (h === Infinity) continue;
        const known = index.get(key);
        if (known !== undefined) {
          // Re-open on a shorter route: the first generation of a state is
          // not always its cheapest, and keeping the dearer one can cost
          // pushes. The state's boxes are the same; its player square and
          // parent follow the cheaper push.
          if (g + 1 >= statesG[known]!) continue;
          statesG[known] = g + 1;
          statesPlayer[known] = b;
          parent[known] = s;
          pushFrom[known] = b;
          pushTo[known] = t;
          touchesExit[known] = reg.touches;
          heap.push({ f: g + 1 + h, g: g + 1, seq: seq++, s: known });
          continue;
        }
        const ns = statesBoxes.length;
        index.set(key, ns);
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesG.push(g + 1);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        touchesExit.push(reg.touches);
        heap.push({ f: g + 1 + h, g: g + 1, seq: seq++, s: ns });
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = statesBoxes[s]!;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const { live } = pullDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Replay `moves` on `level`: the boxes' final squares, or null when a move is illegal. */
function replay(level: Level, moves: string): number[] | null {
  const { w, wall } = level;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  for (const ch of moves.toLowerCase()) {
    const d = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
    const next = player + d;
    if (wall[next]) return null;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return null;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  const out: number[] = [];
  for (let i = 0; i < box.length; i++) if (box[i]) out.push(i);
  return out;
}

/** Solve one level: room by room when it is a set of rooms, else one search over the whole level. */
function solveLevel(level: Level): string {
  const goalSet = new Set(level.goals);
  const solvedBy = (boxes: number[] | null): boolean =>
    boxes !== null && boxes.length === level.goals.length && boxes.every((b) => goalSet.has(b));
  const hallRow = Math.floor(level.player / level.w);

  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      // A solved room must leave the player able to reach the hallway, so
      // the next room stays reachable; retry without that demand if it fails.
      let solved = searchPushOptimal(sub, hallRow, ROOM_EXPANSIONS);
      if (solved === null) solved = searchPushOptimal(sub, -1, ROOM_EXPANSIONS);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    if (ok && solvedBy(replay(level, moves))) return moves;
  }

  const whole = searchPushOptimal(level, -1, LEVEL_EXPANSIONS);
  if (whole !== null && solvedBy(replay(level, whole.moves))) return whole.moves;
  return '';
}

function solve(text: string): string {
  try {
    return solveLevel(parseLevel(text));
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
