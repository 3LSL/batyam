/**
 * Placement of the text the layout engine does not route around: boundary titles, and
 * relationship labels moved by `UpdateRelStyle($offsetX, $offsetY)`.
 */
import type { C4Point, C4Rect } from './c4Layout.js';
import { overlapArea, routeCrossesRect } from './c4Geometry.js';

/** Minimum clearance kept between a title and a line running past it. */
const TITLE_CLEARANCE = 6;

export interface TitlePlacement {
  x: number;
  y: number;
  /** False when no spot in the title strip was free and the title has to cover a line. */
  clear: boolean;
}

interface Interval {
  start: number;
  end: number;
}

/**
 * Finds a spot for a boundary title in the strip reserved for it at the top of the frame.
 *
 * Edges that enter a boundary from above run through that strip, and the layout places them
 * without regard to the title. The title therefore goes in the first stretch of the strip,
 * from the aligned side, that no line, label or element passes through.
 *
 * @param frame - the boundary's frame
 * @param size - the title's size
 * @param padding - the inset between the frame and the title
 * @param align - which side of the strip the title prefers
 * @param routes - every relationship route in the diagram
 * @param rects - every other rectangle that must stay clear (labels, elements, child titles)
 */
export const placeTitle = (
  frame: C4Rect,
  size: { width: number; height: number },
  padding: number,
  align: 'start' | 'end',
  routes: readonly (readonly C4Point[])[],
  rects: readonly C4Rect[]
): TitlePlacement => {
  const top = frame.y + padding;
  const bottom = top + size.height;
  const minX = frame.x + padding;
  const maxX = frame.x + frame.width - padding;
  const preferred = align === 'end' ? maxX - size.width : minX;

  const blocked: Interval[] = [];
  const block = (from: number, to: number) => {
    blocked.push({ start: from - TITLE_CLEARANCE, end: to + TITLE_CLEARANCE });
  };
  for (const route of routes) {
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      if (Math.max(a.y, b.y) >= top - TITLE_CLEARANCE && Math.min(a.y, b.y) <= bottom) {
        // The part of the segment inside the strip, horizontally.
        const xs = clipSegmentToBand(a, b, top - TITLE_CLEARANCE, bottom + TITLE_CLEARANCE);
        if (xs) {
          block(xs.start, xs.end);
        }
      }
    }
  }
  for (const rect of rects) {
    if (rect.y < bottom + TITLE_CLEARANCE && rect.y + rect.height > top - TITLE_CLEARANCE) {
      block(rect.x, rect.x + rect.width);
    }
  }

  const fits = (x: number) =>
    x >= minX - 0.5 &&
    x + size.width <= maxX + 0.5 &&
    blocked.every((interval) => x + size.width <= interval.start || x >= interval.end);

  if (fits(preferred)) {
    return { x: preferred, y: top, clear: true };
  }
  // Candidates sit right after (or, aligning to the end, right before) a blocked stretch.
  const candidates =
    align === 'end'
      ? blocked.map((interval) => interval.start - size.width).sort((a, b) => b - a)
      : blocked.map((interval) => interval.end).sort((a, b) => a - b);
  for (const x of candidates) {
    if (fits(x)) {
      return { x, y: top, clear: true };
    }
  }
  return { x: preferred, y: top, clear: false };
};

/** The horizontal extent of the part of segment `a`-`b` between `top` and `bottom`. */
const clipSegmentToBand = (
  a: C4Point,
  b: C4Point,
  top: number,
  bottom: number
): Interval | undefined => {
  const dy = b.y - a.y;
  if (Math.abs(dy) < 1e-9) {
    if (a.y < top || a.y > bottom) {
      return undefined;
    }
    return { start: Math.min(a.x, b.x), end: Math.max(a.x, b.x) };
  }
  const t0 = Math.max(0, Math.min((top - a.y) / dy, (bottom - a.y) / dy));
  const t1 = Math.min(1, Math.max((top - a.y) / dy, (bottom - a.y) / dy));
  if (t0 > t1) {
    return undefined;
  }
  const x0 = a.x + (b.x - a.x) * t0;
  const x1 = a.x + (b.x - a.x) * t1;
  return { start: Math.min(x0, x1), end: Math.max(x0, x1) };
};

/** A route the title clearing may adjust, with what it is attached to. */
export interface AdjustableRoute {
  /** Orthogonal route; adjusted in place. Its ends lie on the bounding boxes. */
  points: C4Point[];
  /** Bounding box the route starts on, if its first segment may slide along it. */
  source?: C4Rect;
  /** Bounding box the route ends on, if its last segment may slide along it. */
  target?: C4Rect;
  /** The route's own label; it moves with the segment it sits on. Adjusted in place. */
  label?: C4Rect;
}

/** Keeps a moved route end this far from the corners of the box it attaches to. */
const SIDE_MARGIN = 16;
/** Smallest gap kept between two parallel lines. */
const LINE_SEPARATION = 10;

/**
 * Slides vertical route segments sideways, off the boundary titles they run through.
 *
 * An edge that enters a boundary from above runs through the strip reserved for the boundary's
 * title, and in nested boundaries (deployment nodes, typically) through several strips at once,
 * often too narrow for the title to step aside. The segment can usually step aside instead: the
 * last segment may enter its element anywhere along the side, and a segment between two bends
 * may move freely. A move is kept only if the route then crosses no element, title or label and
 * keeps clear of the other routes.
 */
export const routeAroundTitles = (
  routes: AdjustableRoute[],
  titles: readonly C4Rect[],
  elements: readonly C4Rect[]
): void => {
  for (const title of titles) {
    const zone = inflateRect(title, TITLE_CLEARANCE);
    for (const route of routes) {
      for (let i = 0; i < route.points.length - 1; i++) {
        const a = route.points[i];
        const b = route.points[i + 1];
        if (Math.abs(a.x - b.x) > 0.5 || !routeCrossesRect([a, b], zone)) {
          continue;
        }
        shiftVerticalSegment(route, i, routes, titles, elements);
      }
    }
  }
};

const inflateRect = (rect: C4Rect, by: number): C4Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + 2 * by,
  height: rect.height + 2 * by,
});

const shiftVerticalSegment = (
  route: AdjustableRoute,
  index: number,
  routes: readonly AdjustableRoute[],
  titles: readonly C4Rect[],
  elements: readonly C4Rect[]
): void => {
  const points = route.points;
  const last = points.length - 2;
  const a = points[index];
  const b = points[index + 1];
  const x0 = a.x;
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);

  // Where the segment may go: along the side of a box it is attached to, otherwise anywhere.
  let low = -Infinity;
  let high = Infinity;
  const attach = (rect: C4Rect | undefined) => {
    if (rect) {
      low = Math.max(low, rect.x + SIDE_MARGIN);
      high = Math.min(high, rect.x + rect.width - SIDE_MARGIN);
    }
  };
  if (index === 0) {
    attach(route.source);
  }
  if (index === last) {
    attach(route.target);
  }
  if (low > high) {
    return;
  }

  // What the moved segment must keep clear of, as blocked stretches of x.
  const blocked: Interval[] = [];
  const spans = (rect: C4Rect) => rect.y < bottom && rect.y + rect.height > top;
  for (const title of titles) {
    if (spans(inflateRect(title, TITLE_CLEARANCE))) {
      blocked.push({
        start: title.x - TITLE_CLEARANCE,
        end: title.x + title.width + TITLE_CLEARANCE,
      });
    }
  }
  const ownEnds = [
    index === 0 ? route.source : undefined,
    index === last ? route.target : undefined,
  ];
  for (const element of elements) {
    if (!ownEnds.includes(element) && spans(element)) {
      blocked.push({
        start: element.x - LINE_SEPARATION,
        end: element.x + element.width + LINE_SEPARATION,
      });
    }
  }
  for (const other of routes) {
    if (other !== route && other.label && spans(other.label)) {
      blocked.push({
        start: other.label.x - LINE_SEPARATION,
        end: other.label.x + other.label.width + LINE_SEPARATION,
      });
    }
    for (let j = 0; other !== route && j < other.points.length - 1; j++) {
      const p = other.points[j];
      const q = other.points[j + 1];
      if (Math.abs(p.x - q.x) < 0.5 && Math.max(p.y, q.y) > top && Math.min(p.y, q.y) < bottom) {
        blocked.push({ start: p.x - LINE_SEPARATION, end: p.x + LINE_SEPARATION });
      }
    }
  }

  const free = (x: number) =>
    x >= low && x <= high && blocked.every((interval) => x <= interval.start || x >= interval.end);
  const candidates = blocked
    .flatMap((interval) => [interval.start - 1, interval.end + 1])
    .filter(free)
    .sort((p, q) => Math.abs(p - x0) - Math.abs(q - x0));

  const labelOnSegment =
    route.label !== undefined &&
    Math.abs(route.label.x + route.label.width / 2 - x0) < 1 &&
    route.label.y + route.label.height / 2 >= top - 1 &&
    route.label.y + route.label.height / 2 <= bottom + 1;

  for (const x of candidates) {
    const moved = points.map((point) => ({ ...point }));
    moved[index].x = x;
    moved[index + 1].x = x;
    const label =
      labelOnSegment && route.label ? { ...route.label, x: route.label.x + (x - x0) } : route.label;
    if (isRouteClear(moved, route, label, routes, titles, elements)) {
      route.points.splice(0, route.points.length, ...moved);
      if (label && route.label) {
        Object.assign(route.label, label);
      }
      return;
    }
  }
};

const isRouteClear = (
  points: readonly C4Point[],
  route: AdjustableRoute,
  label: C4Rect | undefined,
  routes: readonly AdjustableRoute[],
  titles: readonly C4Rect[],
  elements: readonly C4Rect[]
): boolean => {
  for (const element of elements) {
    if (element === route.source || element === route.target) {
      continue;
    }
    if (routeCrossesRect(points, element)) {
      return false;
    }
  }
  for (const title of titles) {
    if (routeCrossesRect(points, inflateRect(title, TITLE_CLEARANCE - 1))) {
      return false;
    }
  }
  for (const other of routes) {
    if (other === route) {
      continue;
    }
    if (other.label && routeCrossesRect(points, other.label)) {
      return false;
    }
    if (label && routeCrossesRect(other.points, label)) {
      return false;
    }
  }
  if (label) {
    if (elements.some((element) => overlapArea(element, label) > 0)) {
      return false;
    }
    if (titles.some((title) => overlapArea(title, label) > 0)) {
      return false;
    }
  }
  return true;
};

/** How far a label moved by an offset may stray from its own line. */
const MAX_LABEL_DETACHMENT = 24;

/** How close to a corner of its route a label counts as over the bend. */
const BEND_CLEARANCE = 6;

/** Whether a label sits over a bend in its own route, where the line turns behind it. */
export const labelOnBend = (rect: C4Rect, route: readonly C4Point[]): boolean =>
  route
    .slice(1, -1)
    .some(
      (corner) =>
        corner.x > rect.x - BEND_CLEARANCE &&
        corner.x < rect.x + rect.width + BEND_CLEARANCE &&
        corner.y > rect.y - BEND_CLEARANCE &&
        corner.y < rect.y + rect.height + BEND_CLEARANCE
    );

/**
 * Applies an `UpdateRelStyle` offset to a placed label, if the moved label stays clear.
 *
 * Offsets were the way to steer labels away from each other when labels sat on the midpoint of
 * a straight line. The layout now places labels so they collide with nothing, and most offsets
 * written for the old placement would push a label onto a box or away from its line. An offset
 * is therefore honoured only when the moved label still overlaps no element, title, other label
 * or other line, and stays close to its own line without landing over a bend in it.
 */
export const applyLabelOffset = (
  label: C4Rect,
  offset: { x: number; y: number },
  ownRoute: readonly C4Point[],
  otherRoutes: readonly (readonly C4Point[])[],
  obstacles: readonly C4Rect[]
): C4Rect => {
  if (!offset.x && !offset.y) {
    return label;
  }
  const moved = { ...label, x: label.x + offset.x, y: label.y + offset.y };
  if (obstacles.some((rect) => overlapArea(rect, moved) > 0)) {
    return label;
  }
  if (otherRoutes.some((route) => routeCrossesRect(route, moved))) {
    return label;
  }
  const reach = {
    x: moved.x - MAX_LABEL_DETACHMENT,
    y: moved.y - MAX_LABEL_DETACHMENT,
    width: moved.width + 2 * MAX_LABEL_DETACHMENT,
    height: moved.height + 2 * MAX_LABEL_DETACHMENT,
  };
  if (!routeCrossesRect(ownRoute, reach)) {
    return label;
  }
  if (labelOnBend(moved, ownRoute) && !labelOnBend(label, ownRoute)) {
    return label;
  }
  return moved;
};
