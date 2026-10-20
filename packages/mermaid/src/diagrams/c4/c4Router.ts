// cspell:ignore Wybrow Marriott Stuckey

/**
 * An orthogonal connector router: finds an axis-aligned route between two points that keeps
 * clear of a set of rectangles, preferring short routes with few bends.
 *
 * The C4 layout uses it where the layout engine's own routing cannot be used or has to be
 * repaired. It searches a sparse grid made from the obstacles' sides and the channels between
 * them (an orthogonal visibility graph, as in Wybrow, Marriott and Stuckey, "Orthogonal
 * Connector Routing"), with Dijkstra's algorithm over (point, heading) states, so a bend costs
 * extra.
 */
import type { C4Point, C4Rect } from './c4Layout.js';
import { simplifyRoute } from './c4Geometry.js';

export type C4Heading = 'up' | 'down' | 'left' | 'right';

const STEP: Record<C4Heading, C4Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export interface RouteEnd {
  point: C4Point;
  /**
   * Leaving the start: the direction the route sets off in. Arriving at the end: the direction
   * the route travels in as it arrives. The route keeps that heading for at least `stub`.
   */
  heading: C4Heading;
}

export interface RouteRequest {
  /** Where the route may start; the cheapest of the candidates is used. */
  start: RouteEnd | readonly RouteEnd[];
  /** Where the route may end; the cheapest of the candidates is used. */
  end: RouteEnd | readonly RouteEnd[];
  /** Rectangles the route must not enter (they are kept `clearance` away). */
  obstacles: readonly C4Rect[];
  /** Existing routes the new one should keep away from and not run along. */
  avoid?: readonly (readonly C4Point[])[];
  /** Points where other routes already end; a candidate end near one costs extra. */
  occupied?: readonly C4Point[];
  clearance?: number;
  /** Length of the straight run at each end, before the first and after the last bend. */
  stub?: number;
  bendCost?: number;
}

interface Segment {
  a: C4Point;
  b: C4Point;
}

const EPSILON = 1e-6;

/** Whether an axis-aligned segment enters the interior of `rect`. */
const segmentEntersRect = (a: C4Point, b: C4Point, rect: C4Rect): boolean => {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return (
    maxX > rect.x + EPSILON &&
    minX < rect.x + rect.width - EPSILON &&
    maxY > rect.y + EPSILON &&
    minY < rect.y + rect.height - EPSILON
  );
};

const pointInRect = (point: C4Point, rect: C4Rect): boolean =>
  point.x > rect.x + EPSILON &&
  point.x < rect.x + rect.width - EPSILON &&
  point.y > rect.y + EPSILON &&
  point.y < rect.y + rect.height - EPSILON;

/** A binary min-heap keyed on `cost`. */
class Heap<T extends { cost: number }> {
  private items: T[] = [];
  get size() {
    return this.items.length;
  }
  push(item: T) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].cost <= items[i].cost) {
        break;
      }
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) {
      return undefined;
    }
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].cost < items[smallest].cost) {
          smallest = left;
        }
        if (right < items.length && items[right].cost < items[smallest].cost) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

const sortedUnique = (values: number[]): number[] => {
  const sorted = [...values].sort((a, b) => a - b);
  const unique: number[] = [];
  for (const value of sorted) {
    // Only exact repeats merge: a grid line moved even slightly would leave the route's ends
    // a fraction of a pixel off the line they run along.
    if (unique.length === 0 || value - unique[unique.length - 1] > 1e-6) {
      unique.push(value);
    }
  }
  return unique;
};

/**
 * Routes from one of the `start` candidates to one of the `end` candidates. Returns the route,
 * from the chosen start point to the chosen end point, or `undefined` when no route avoids the
 * obstacles.
 */
export const routeOrthogonal = (request: RouteRequest): C4Point[] | undefined => {
  const clearance = request.clearance ?? 12;
  const stub = request.stub ?? 14;
  const bendCost = request.bendCost ?? 60;
  const blocked = request.obstacles.map((rect) => ({
    x: rect.x - clearance,
    y: rect.y - clearance,
    width: rect.width + 2 * clearance,
    height: rect.height + 2 * clearance,
  }));
  const isFree = (point: C4Point) => !blocked.some((rect) => pointInRect(point, rect));

  // Each candidate end continues straight for `stub` before the grid search takes over.
  const starts = (Array.isArray(request.start) ? request.start : [request.start])
    .map((end: RouteEnd) => ({
      end,
      stub: {
        x: end.point.x + STEP[end.heading].x * stub,
        y: end.point.y + STEP[end.heading].y * stub,
      },
    }))
    .filter(({ stub }) => isFree(stub));
  const ends = (Array.isArray(request.end) ? request.end : [request.end])
    .map((end: RouteEnd) => ({
      end,
      stub: {
        x: end.point.x - STEP[end.heading].x * stub,
        y: end.point.y - STEP[end.heading].y * stub,
      },
    }))
    .filter(({ stub }) => isFree(stub));
  if (starts.length === 0 || ends.length === 0) {
    return undefined;
  }

  // Grid lines: the obstacles' sides, the channels between them and the candidate ends.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { stub } of [...starts, ...ends]) {
    xs.push(stub.x);
    ys.push(stub.y);
  }
  for (const rect of blocked) {
    xs.push(rect.x, rect.x + rect.width);
    ys.push(rect.y, rect.y + rect.height);
  }
  const addChannels = (values: number[]) => {
    const sorted = sortedUnique(values);
    for (let i = 0; i < sorted.length - 1; i++) {
      values.push((sorted[i] + sorted[i + 1]) / 2);
    }
    // Room to go around everything.
    values.push(sorted[0] - 4 * clearance, sorted[sorted.length - 1] + 4 * clearance);
  };
  addChannels(xs);
  addChannels(ys);
  const gridX = sortedUnique(xs);
  const gridY = sortedUnique(ys);

  const avoidSegments: Segment[] = [];
  for (const route of request.avoid ?? []) {
    for (let i = 0; i < route.length - 1; i++) {
      avoidSegments.push({ a: route[i], b: route[i + 1] });
    }
  }
  // Running along an existing line, or crossing one, costs extra.
  const contactCost = (a: C4Point, b: C4Point): number => {
    let cost = 0;
    const horizontal = Math.abs(a.y - b.y) < EPSILON;
    for (const segment of avoidSegments) {
      const segmentHorizontal = Math.abs(segment.a.y - segment.b.y) < EPSILON;
      if (horizontal === segmentHorizontal) {
        const gap = horizontal ? Math.abs(a.y - segment.a.y) : Math.abs(a.x - segment.a.x);
        if (gap < clearance) {
          const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
          const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
          const segmentLo = horizontal
            ? Math.min(segment.a.x, segment.b.x)
            : Math.min(segment.a.y, segment.b.y);
          const segmentHi = horizontal
            ? Math.max(segment.a.x, segment.b.x)
            : Math.max(segment.a.y, segment.b.y);
          const shared = Math.min(hi, segmentHi) - Math.max(lo, segmentLo);
          if (shared > 0) {
            cost += shared * 20;
          }
        }
      } else {
        // Perpendicular: a crossing.
        const [h, v] = horizontal ? [{ a, b }, segment] : [segment, { a, b }];
        const hy = h.a.y;
        const vx = v.a.x;
        if (
          vx > Math.min(h.a.x, h.b.x) + EPSILON &&
          vx < Math.max(h.a.x, h.b.x) - EPSILON &&
          hy > Math.min(v.a.y, v.b.y) + EPSILON &&
          hy < Math.max(v.a.y, v.b.y) - EPSILON
        ) {
          cost += 40;
        }
      }
    }
    return cost;
  };

  const columns = gridX.length;
  const cellOf = (point: C4Point) => {
    const nearest = (values: number[], value: number) => {
      let best = 0;
      for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - value) < Math.abs(values[best] - value)) {
          best = i;
        }
      }
      return best;
    };
    return { ix: nearest(gridX, point.x), iy: nearest(gridY, point.y) };
  };
  const index = (ix: number, iy: number) => iy * columns + ix;
  const free = new Uint8Array(gridX.length * gridY.length);
  for (const [iy, y] of gridY.entries()) {
    for (const [ix, x] of gridX.entries()) {
      free[index(ix, iy)] = isFree({ x, y }) ? 1 : 0;
    }
  }

  const headings: C4Heading[] = ['up', 'down', 'left', 'right'];
  const stateKey = (cell: number, heading: number) => cell * 4 + heading;
  const best = new Float64Array(gridX.length * gridY.length * 4).fill(Infinity);
  const previous = new Int32Array(gridX.length * gridY.length * 4).fill(-1);
  const heap = new Heap<{ cost: number; ix: number; iy: number; heading: number }>();

  // An end where another route already ends would put two arrowheads, or a line and an
  // arrowhead, on top of each other.
  const occupiedCost = (point: C4Point) =>
    (request.occupied ?? []).some(
      (other) => Math.hypot(other.x - point.x, other.y - point.y) < clearance
    )
      ? 400
      : 0;
  const startOfState = new Map<number, RouteEnd>();
  for (const { end, stub: point } of starts) {
    const { ix, iy } = cellOf(point);
    const heading = headings.indexOf(end.heading);
    const state = stateKey(index(ix, iy), heading);
    const cost = occupiedCost(end.point);
    if (best[state] > cost) {
      best[state] = cost;
      startOfState.set(state, end);
      heap.push({ cost, ix, iy, heading });
    }
  }
  const endOfState = new Map<number, RouteEnd>();
  const endCost = new Map<number, number>();
  for (const { end, stub: point } of ends) {
    const { ix, iy } = cellOf(point);
    const state = stateKey(index(ix, iy), headings.indexOf(end.heading));
    const cost = occupiedCost(end.point);
    if (!endOfState.has(state) || cost < endCost.get(state)!) {
      endOfState.set(state, end);
      endCost.set(state, cost);
    }
  }

  let found = -1;
  // Reaching an end state does not finish the search at once: the end's own cost is added and
  // the state queued again, so a cheaper end reached a little later can still win.
  const finished = new Set<number>();
  while (heap.size > 0) {
    const current = heap.pop()!;
    const state = stateKey(index(current.ix, current.iy), current.heading);
    if (finished.has(state)) {
      found = state;
      break;
    }
    if (current.cost > best[state]) {
      continue;
    }
    if (endOfState.has(state)) {
      finished.add(state);
      heap.push({ ...current, cost: current.cost + endCost.get(state)! });
      continue;
    }
    for (const [h, heading] of headings.entries()) {
      // No turning back on oneself.
      const step = STEP[heading];
      const currentStep = STEP[headings[current.heading]];
      if (step.x === -currentStep.x && step.y === -currentStep.y) {
        continue;
      }
      const nx = current.ix + step.x;
      const ny = current.iy + step.y;
      if (nx < 0 || ny < 0 || nx >= gridX.length || ny >= gridY.length) {
        continue;
      }
      if (!free[index(nx, ny)]) {
        continue;
      }
      const a = { x: gridX[current.ix], y: gridY[current.iy] };
      const b = { x: gridX[nx], y: gridY[ny] };
      if (blocked.some((rect) => segmentEntersRect(a, b, rect))) {
        continue;
      }
      const cost =
        current.cost +
        Math.abs(b.x - a.x) +
        Math.abs(b.y - a.y) +
        (h === current.heading ? 0 : bendCost) +
        contactCost(a, b);
      const next = stateKey(index(nx, ny), h);
      if (cost < best[next]) {
        best[next] = cost;
        previous[next] = state;
        heap.push({ cost, ix: nx, iy: ny, heading: h });
      }
    }
  }
  if (found < 0) {
    return undefined;
  }

  const path: C4Point[] = [];
  let first = found;
  for (let state = found; state >= 0; state = previous[state]) {
    const cell = Math.floor(state / 4);
    path.push({ x: gridX[cell % columns], y: gridY[Math.floor(cell / columns)] });
    first = state;
  }
  path.reverse();
  const start = startOfState.get(first)!;
  const end = endOfState.get(found)!;
  return simplifyRoute([start.point, ...path, end.point]);
};

/**
 * Candidate attachment points on the four sides of a box: the middle of each side and points
 * spread out from it. Leaving the box a route heads away from the side; arriving, into it.
 */
export const sidePorts = (rect: C4Rect, arriving: boolean, margin = 16): RouteEnd[] => {
  const ports: RouteEnd[] = [];
  // The middle of the side first, then points further out, as long as they stay clear of the
  // corners.
  const along = (length: number) =>
    [0.5, 1 / 3, 2 / 3, 0.25, 0.75, 1 / 6, 5 / 6].filter(
      (t) => t === 0.5 || (t * length >= margin && (1 - t) * length >= margin)
    );
  for (const t of along(rect.width)) {
    const x = rect.x + rect.width * t;
    ports.push(
      { point: { x, y: rect.y }, heading: arriving ? 'down' : 'up' },
      { point: { x, y: rect.y + rect.height }, heading: arriving ? 'up' : 'down' }
    );
  }
  for (const t of along(rect.height)) {
    const y = rect.y + rect.height * t;
    ports.push(
      { point: { x: rect.x, y }, heading: arriving ? 'right' : 'left' },
      { point: { x: rect.x + rect.width, y }, heading: arriving ? 'left' : 'right' }
    );
  }
  return ports;
};
