/**
 * Geometry for the C4 layout: the true outlines of the element shapes, and the rectangle and
 * segment tests the layout clean-up relies on. Everything here is pure.
 */
import type { C4Point, C4Rect } from './c4Layout.js';

/** The outlines of the shapes C4 elements are drawn with. */
export type C4OutlineKind = 'rect' | 'rounded' | 'person' | 'cylinder' | 'queue';

export interface C4Outline {
  kind: C4OutlineKind;
  rect: C4Rect;
  /** Corner radius of a `rounded` box. */
  radius?: number;
}

const EPSILON = 1e-6;

const insideRoundedRect = (rect: C4Rect, radius: number, point: C4Point): boolean => {
  const { x, y, width, height } = rect;
  if (point.x < x || point.x > x + width || point.y < y || point.y > y + height) {
    return false;
  }
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) {
    return true;
  }
  // Inside unless it is in a corner square and outside that corner's circle.
  const cx = point.x < x + r ? x + r : point.x > x + width - r ? x + width - r : point.x;
  const cy = point.y < y + r ? y + r : point.y > y + height - r ? y + height - r : point.y;
  return (point.x - cx) ** 2 + (point.y - cy) ** 2 <= r * r + EPSILON;
};

const insideEllipse = (cx: number, cy: number, rx: number, ry: number, point: C4Point): boolean =>
  rx > 0 && ry > 0 && ((point.x - cx) / rx) ** 2 + ((point.y - cy) / ry) ** 2 <= 1 + EPSILON;

/**
 * The person figure: a round head over a rounded body. Mirrors the proportions in
 * `rendering-elements/shapes/person.ts`.
 */
export const personGeometry = (rect: C4Rect) => {
  const headRadius = Math.min(Math.max(rect.width * 0.23, 16), 56);
  const overlap = headRadius * 0.27;
  const bodyTop = rect.y + 2 * headRadius - overlap;
  const bodyHeight = rect.y + rect.height - bodyTop;
  const bodyRadius = Math.min(rect.width * 0.177, bodyHeight * 0.45);
  return {
    head: { cx: rect.x + rect.width / 2, cy: rect.y + headRadius, r: headRadius },
    body: { x: rect.x, y: bodyTop, width: rect.width, height: bodyHeight },
    bodyRadius,
  };
};

/** A database: an upright cylinder. Mirrors `rendering-elements/shapes/cylinder.ts`. */
export const cylinderGeometry = (rect: C4Rect) => {
  const rx = rect.width / 2;
  const ry = rx / (2.5 + rect.width / 50);
  return { rx, ry };
};

/** A queue: a cylinder on its side. Mirrors `rendering-elements/shapes/tiltedCylinder.ts`. */
export const queueGeometry = (rect: C4Rect) => {
  const ry = rect.height / 2;
  const rx = ry / (2.5 + rect.height / 50);
  return { rx, ry };
};

export const insideOutline = (outline: C4Outline, point: C4Point): boolean => {
  const { rect } = outline;
  switch (outline.kind) {
    case 'rounded':
      return insideRoundedRect(rect, outline.radius ?? 0, point);
    case 'person': {
      const { head, body, bodyRadius } = personGeometry(rect);
      return (
        insideEllipse(head.cx, head.cy, head.r, head.r, point) ||
        insideRoundedRect(body, bodyRadius, point)
      );
    }
    case 'cylinder': {
      const { rx, ry } = cylinderGeometry(rect);
      const cx = rect.x + rect.width / 2;
      return (
        insideEllipse(cx, rect.y + ry, rx, ry, point) ||
        insideEllipse(cx, rect.y + rect.height - ry, rx, ry, point) ||
        insideRoundedRect(
          { x: rect.x, y: rect.y + ry, width: rect.width, height: rect.height - 2 * ry },
          0,
          point
        )
      );
    }
    case 'queue': {
      const { rx, ry } = queueGeometry(rect);
      const cy = rect.y + rect.height / 2;
      return (
        insideEllipse(rect.x + rx, cy, rx, ry, point) ||
        insideEllipse(rect.x + rect.width - rx, cy, rx, ry, point) ||
        insideRoundedRect(
          { x: rect.x + rx, y: rect.y, width: rect.width - 2 * rx, height: rect.height },
          0,
          point
        )
      );
    }
    default:
      return insideRoundedRect(rect, 0, point);
  }
};

/**
 * Moves a route's end onto the drawn outline. Layouts end a route on the bounding box, which
 * leaves a gap wherever the shape does not fill its box: beside a person's head, above the
 * curve of a database, inside a rounded corner. The end is moved along the direction the route
 * arrives in until it meets the outline; a route that would miss the shape keeps its end.
 *
 * @param from - the point the route arrives from
 * @param end - the current end of the route, on or near the bounding box
 */
export const snapToOutline = (outline: C4Outline, from: C4Point, end: C4Point): C4Point => {
  const dx = end.x - from.x;
  const dy = end.y - from.y;
  if (Math.hypot(dx, dy) < EPSILON || insideOutline(outline, end)) {
    return end;
  }
  // Routes are orthogonal: carry on along the axis the last segment runs on, so a sliver of
  // misalignment is not stretched into a visible slant.
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const ux = vertical ? 0 : Math.sign(dx);
  const uy = vertical ? Math.sign(dy) : 0;
  end = vertical ? { x: from.x, y: end.y } : { x: end.x, y: from.y };
  const reach = Math.max(outline.rect.width, outline.rect.height);
  const step = 1;
  let outside = 0;
  for (let travelled = step; travelled <= reach; travelled += step) {
    const probe = { x: end.x + ux * travelled, y: end.y + uy * travelled };
    if (insideOutline(outline, probe)) {
      // Refine between the last point outside and the first one inside.
      let low = outside;
      let high = travelled;
      for (let i = 0; i < 20; i++) {
        const mid = (low + high) / 2;
        if (insideOutline(outline, { x: end.x + ux * mid, y: end.y + uy * mid })) {
          high = mid;
        } else {
          low = mid;
        }
      }
      return { x: end.x + ux * high, y: end.y + uy * high };
    }
    outside = travelled;
  }
  return end;
};

// ---------------------------------------------------------------------------------------------
// Rectangles and segments
// ---------------------------------------------------------------------------------------------

export const rectsOverlap = (a: C4Rect, b: C4Rect, margin = 0): boolean =>
  a.x < b.x + b.width + margin &&
  b.x < a.x + a.width + margin &&
  a.y < b.y + b.height + margin &&
  b.y < a.y + a.height + margin;

/** Area shared by two rectangles. */
export const overlapArea = (a: C4Rect, b: C4Rect): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
};

export const inflate = (rect: C4Rect, by: number): C4Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + 2 * by,
  height: rect.height + 2 * by,
});

export const containsRect = (outer: C4Rect, inner: C4Rect, tolerance = 0.5): boolean =>
  inner.x >= outer.x - tolerance &&
  inner.y >= outer.y - tolerance &&
  inner.x + inner.width <= outer.x + outer.width + tolerance &&
  inner.y + inner.height <= outer.y + outer.height + tolerance;

/** Whether the segment from `a` to `b` passes through the inside of `rect` (touching is not). */
export const segmentCrossesRect = (a: C4Point, b: C4Point, rect: C4Rect): boolean => {
  // Liang-Barsky clipping against the open rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < EPSILON) {
      if (q <= EPSILON) {
        return false;
      }
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) {
          return false;
        }
        t0 = Math.max(t0, t);
      } else {
        if (t < t0) {
          return false;
        }
        t1 = Math.min(t1, t);
      }
    }
  }
  return t1 - t0 > EPSILON && (t1 - t0) * Math.hypot(dx, dy) > 0.5;
};

export const routeCrossesRect = (points: readonly C4Point[], rect: C4Rect): boolean => {
  for (let i = 0; i < points.length - 1; i++) {
    if (segmentCrossesRect(points[i], points[i + 1], rect)) {
      return true;
    }
  }
  return false;
};

/** The point halfway along a route, by length. */
export const routeMidpoint = (points: readonly C4Point[]): C4Point => {
  return pointAlongRoute(points, routeLength(points) / 2);
};

export const routeLength = (points: readonly C4Point[]): number => {
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return length;
};

export const pointAlongRoute = (points: readonly C4Point[], distance: number): C4Point => {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  let remaining = Math.max(0, distance);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length && length > 0) {
      const t = remaining / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return points[points.length - 1];
};

/** Removes repeated points and the middle point of three in a straight line. */
export const simplifyRoute = (points: readonly C4Point[]): C4Point[] => {
  const deduplicated: C4Point[] = [];
  for (const point of points) {
    const last = deduplicated.at(-1);
    if (!last || Math.abs(last.x - point.x) > 0.01 || Math.abs(last.y - point.y) > 0.01) {
      deduplicated.push({ ...point });
    }
  }
  const simplified: C4Point[] = [];
  for (const point of deduplicated) {
    while (simplified.length >= 2) {
      const a = simplified[simplified.length - 2];
      const b = simplified[simplified.length - 1];
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const dot = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      if (Math.abs(cross) < 0.01 && dot >= 0) {
        simplified.pop();
      } else {
        break;
      }
    }
    simplified.push(point);
  }
  return simplified;
};

export const unionRect = (rects: readonly C4Rect[]): C4Rect | undefined => {
  if (rects.length === 0) {
    return undefined;
  }
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
