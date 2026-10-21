/**
 * Turns the layout engine's result into the final C4 geometry, and repairs what the engine got
 * wrong. Pure: it works on rectangles and routes only.
 *
 * In order:
 * 1. Each boundary title is given its preferred spot, its boundary's top-left corner. The
 *    side-by-side relationships, which the layout positions but does not route, are routed.
 *    Lines through a title are slid aside (`routeAroundTitles`).
 * 2. A route that still crosses an element, a title or another relationship's label is routed
 *    afresh around them.
 * 3. Two routes running along each other are pulled apart, and small steps in a route that
 *    lead nowhere are straightened out.
 * 4. The ends of every route are moved onto the true outlines of the shapes they attach to.
 * 5. Each title takes the first free stretch of its strip; one that has none is lifted above
 *    the lines and backed so they pass behind it.
 * 6. A label that collides with anything slides along its route to the nearest free spot.
 * 7. `UpdateRelStyle` offsets are applied where they keep the label clear.
 */
import type { C4Outline, C4OutlineKind } from './c4Geometry.js';
import {
  overlapArea,
  routeCrossesRect,
  routeLength,
  routeMidpoint,
  simplifyRoute,
  snapToOutline,
} from './c4Geometry.js';
import type { C4Point, C4Rect } from './c4Layout.js';
import type { AdjustableRoute } from './c4Placement.js';
import { applyLabelOffset, labelOnBend, placeTitle, routeAroundTitles } from './c4Placement.js';
import type { C4Heading, RouteEnd } from './c4Router.js';
import { routeOrthogonal, sidePorts } from './c4Router.js';

export interface RefineElement {
  rect: C4Rect;
  outline: C4OutlineKind;
  /** Corner radius, for `rounded` outlines. */
  radius?: number;
  /** The boundary the element sits in, if any. */
  parent?: string;
}

export interface RefineBoundary {
  rect: C4Rect;
  parent?: string;
  title?: { width: number; height: number };
  /** Which corner the title prefers. */
  titleAlign: 'start' | 'end';
  /** The boundary's own padding, where it differs from `RefineInput.boundaryPadding`. */
  padding?: number;
}

export interface RefineRel {
  id: string;
  from: string;
  to: string;
  /** The route from `from` to `to`, its ends on the bounding boxes. Empty if still unrouted. */
  points: C4Point[];
  /** The label's size and where the layout put it, if there is a label. */
  label?: C4Rect;
  offset: C4Point;
  /**
   * For a side-by-side relationship the layout did not route: the gap between the two ends'
   * boxes it crosses, where its label goes.
   */
  gap?: C4Rect;
  /** The axis the two ends are lined up along, for a side-by-side relationship. */
  gapAxis?: 'x' | 'y';
  /** Set for a relationship between a boundary and something inside it, still to be routed. */
  nested?: boolean;
}

export interface RefineInput {
  elements: Map<string, RefineElement>;
  boundaries: Map<string, RefineBoundary>;
  rels: RefineRel[];
  boundaryPadding: number;
}

export interface RefinedTitle {
  rect: C4Rect;
  /** True when the title could not avoid a line, so it is drawn above the lines. */
  overlay: boolean;
}

export interface RefineOutput {
  routes: Map<string, C4Point[]>;
  labels: Map<string, C4Rect>;
  titles: Map<string, RefinedTitle>;
}

/** Clearance kept between a rerouted line and the obstacles it passes. */
const ROUTE_CLEARANCE = 12;
/** Smallest gap between two lines that run side by side. */
const PARALLEL_GAP = 12;
/** A label keeps this far from where its line meets an element. */
const LABEL_END_CLEARANCE = 16;

const ancestorsOf = (boundaries: Map<string, RefineBoundary>, alias?: string): Set<string> => {
  const result = new Set<string>();
  let current = alias;
  while (current && boundaries.has(current) && !result.has(current)) {
    result.add(current);
    current = boundaries.get(current)!.parent;
  }
  return result;
};

const headingOf = (from: C4Point, to: C4Point): C4Heading => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'down' : 'up';
};

export const refineLayout = (input: RefineInput): RefineOutput => {
  const { elements, boundaries, rels, boundaryPadding } = input;
  const routes = new Map<string, C4Point[]>();
  const labels = new Map<string, C4Rect>();
  for (const rel of rels) {
    routes.set(rel.id, simplifyRoute(rel.points));
    if (rel.label) {
      labels.set(rel.id, { ...rel.label });
    }
  }
  const rectOf = (alias: string) => elements.get(alias)?.rect ?? boundaries.get(alias)?.rect;
  const elementRects = [...elements.values()].map(({ rect }) => rect);

  // 1. Preferred titles; lines through them are slid aside.
  const paddingOf = (boundary: RefineBoundary) => boundary.padding ?? boundaryPadding;
  const preferredTitles = new Map<string, C4Rect>();
  for (const [alias, boundary] of boundaries) {
    if (boundary.title) {
      const { width, height } = boundary.title;
      const padding = paddingOf(boundary);
      const x =
        boundary.titleAlign === 'end'
          ? boundary.rect.x + boundary.rect.width - padding - width
          : boundary.rect.x + padding;
      preferredTitles.set(alias, { x, y: boundary.rect.y + padding, width, height });
    }
  }
  // Side-by-side and nested relationships, which the layout placed but did not route.
  for (const rel of rels) {
    if (rel.gap && routes.get(rel.id)!.length < 2) {
      routeSideBySide(rel, input, routes, labels, preferredTitles.values());
    } else if (rel.nested && routes.get(rel.id)!.length < 2) {
      routeNested(rel, input, routes, labels, preferredTitles.values());
    }
  }
  const adjustable = rels.map(
    (rel): AdjustableRoute => ({
      points: routes.get(rel.id)!,
      source: rectOf(rel.from),
      target: rectOf(rel.to),
      label: labels.get(rel.id),
    })
  );
  routeAroundTitles(adjustable, [...preferredTitles.values()], elementRects);

  // 2. Reroute what still crosses an element, a title or a foreign label.
  const titleRects = () => [...preferredTitles.values()];
  const crossesSomething = (rel: RefineRel, points: C4Point[]): boolean => {
    for (const [alias, element] of elements) {
      if (alias !== rel.from && alias !== rel.to && routeCrossesRect(points, element.rect)) {
        return true;
      }
    }
    if (titleRects().some((title) => routeCrossesRect(points, title))) {
      return true;
    }
    for (const other of rels) {
      const label = labels.get(other.id);
      if (other.id !== rel.id && label && routeCrossesRect(points, label)) {
        return true;
      }
    }
    // Into and out of a boundary that holds neither end.
    const related = new Set([
      ...ancestorsOf(boundaries, elements.get(rel.from)?.parent ?? rel.from),
      ...ancestorsOf(boundaries, elements.get(rel.to)?.parent ?? rel.to),
    ]);
    for (const [alias, boundary] of boundaries) {
      if (!related.has(alias) && routeCrossesRect(points, shrink(boundary.rect, 1))) {
        return true;
      }
    }
    return false;
  };
  for (const rel of rels) {
    const points = routes.get(rel.id)!;
    if (points.length >= 2 && rel.from !== rel.to && crossesSomething(rel, points)) {
      const rerouted = reroute(rel, points, input, routes, labels, preferredTitles);
      if (rerouted && !crossesSomething(rel, rerouted)) {
        routes.set(rel.id, rerouted);
        const label = labels.get(rel.id);
        if (label) {
          labels.set(rel.id, centreOnLongestSegment(rerouted, label));
        }
      }
    }
  }

  // 3. Pull apart lines that run along each other, then take out the small steps the engine
  //    leaves in them.
  separateParallelRuns(
    rels,
    routes,
    labels,
    elementRects,
    [...preferredTitles.values()],
    rectOf,
    input
  );
  straightenJogs(rels, routes, labels, elementRects, [...preferredTitles.values()], rectOf);

  // 4. Onto the true outlines.
  for (const rel of rels) {
    const points = routes.get(rel.id)!;
    if (points.length < 2) {
      continue;
    }
    const outline = (alias: string): C4Outline | undefined => {
      const element = elements.get(alias);
      if (element) {
        return { kind: element.outline, rect: element.rect, radius: element.radius };
      }
      const boundary = boundaries.get(alias);
      return boundary ? { kind: 'rect', rect: boundary.rect } : undefined;
    };
    const start = outline(rel.from);
    const end = outline(rel.to);
    if (start) {
      points[0] = snapToOutline(start, points[1], points[0]);
    }
    if (end) {
      const last = points.length - 1;
      points[last] = snapToOutline(end, points[last - 1], points[last]);
    }
  }

  // Square up whatever is left a fraction off the axes, and take out any slanted step.
  for (const rel of rels) {
    squareUp(routes.get(rel.id)!);
  }

  // 5. Titles.
  const allRoutes = rels.map((rel) => routes.get(rel.id)!);
  const titles = new Map<string, RefinedTitle>();
  for (const [alias, boundary] of boundaries) {
    if (!boundary.title) {
      continue;
    }
    const placement = placeTitle(
      boundary.rect,
      boundary.title,
      paddingOf(boundary),
      boundary.titleAlign,
      allRoutes,
      [...labels.values(), ...elementRects]
    );
    titles.set(alias, {
      rect: { x: placement.x, y: placement.y, ...boundary.title },
      overlay: !placement.clear,
    });
  }

  // 6. Labels clear of everything.
  const titleList = [...titles.values()].map(({ rect }) => rect);
  for (const rel of rels) {
    const label = labels.get(rel.id);
    if (!label) {
      continue;
    }
    const otherRoutes = rels.filter((other) => other !== rel).map((other) => routes.get(other.id)!);
    const otherLabels = rels
      .filter((other) => other !== rel && labels.has(other.id))
      .map((other) => labels.get(other.id)!);
    const weighted: WeightedObstacles = {
      elements: elementRects,
      titles: titleList,
      labels: otherLabels,
      frames: frameEdges(boundaries),
      routes: otherRoutes,
    };
    const obstacles = [...elementRects, ...titleList, ...otherLabels, ...weighted.frames];
    const route = routes.get(rel.id)!;
    // Also a label left beside its line rather than centred on it, or over a bend in it.
    if (
      labelCollides(label, obstacles, otherRoutes) ||
      !labelCentredOnRoute(label, route) ||
      labelOnBend(label, route)
    ) {
      labels.set(rel.id, slideLabel(route, label, obstacles, otherRoutes, weighted));
    }
  }

  // 7. Offsets.
  for (const rel of rels) {
    const label = labels.get(rel.id);
    if (!label || (!rel.offset.x && !rel.offset.y)) {
      continue;
    }
    const otherRoutes = rels.filter((other) => other !== rel).map((other) => routes.get(other.id)!);
    const otherLabels = rels
      .filter((other) => other !== rel && labels.has(other.id))
      .map((other) => labels.get(other.id)!);
    labels.set(
      rel.id,
      applyLabelOffset(label, rel.offset, routes.get(rel.id)!, otherRoutes, [
        ...elementRects,
        ...titleList,
        ...otherLabels,
        ...frameEdges(boundaries),
      ])
    );
  }

  return { routes, labels, titles };
};

const shrink = (rect: C4Rect, by: number): C4Rect => ({
  x: rect.x + by,
  y: rect.y + by,
  width: rect.width - 2 * by,
  height: rect.height - 2 * by,
});

/** Thin rectangles along every boundary border, so a label cannot straddle one. */
const frameEdges = (boundaries: Map<string, RefineBoundary>): C4Rect[] =>
  [...boundaries.values()].flatMap(({ rect }) => [
    { x: rect.x, y: rect.y, width: rect.width, height: 1 },
    { x: rect.x, y: rect.y + rect.height - 1, width: rect.width, height: 1 },
    { x: rect.x, y: rect.y, width: 1, height: rect.height },
    { x: rect.x + rect.width - 1, y: rect.y, width: 1, height: rect.height },
  ]);

const labelCollides = (
  label: C4Rect,
  obstacles: readonly C4Rect[],
  otherRoutes: readonly (readonly C4Point[])[]
): boolean =>
  obstacles.some((rect) => overlapArea(rect, label) > 0.5) ||
  otherRoutes.some((route) => routeCrossesRect(route, label));

interface WeightedObstacles {
  elements: readonly C4Rect[];
  titles: readonly C4Rect[];
  labels: readonly C4Rect[];
  frames: readonly C4Rect[];
  routes: readonly (readonly C4Point[])[];
}

/**
 * What a label in `rect` collides with, as a penalty. Covering an element's or another label's
 * text is worst; a boundary's border through the label is minor; a line running behind the
 * label is less bad than either, since the label's background keeps the text readable.
 */
const labelPenalty = (rect: C4Rect, obstacles: WeightedObstacles): number => {
  let penalty = 0;
  for (const element of obstacles.elements) {
    penalty += 10 * overlapArea(element, rect);
  }
  for (const label of obstacles.labels) {
    penalty += 10 * overlapArea(label, rect);
  }
  for (const title of obstacles.titles) {
    penalty += 5 * overlapArea(title, rect);
  }
  for (const frame of obstacles.frames) {
    penalty += overlapArea(frame, rect) > 0 ? 120 : 0;
  }
  for (const route of obstacles.routes) {
    penalty += routeCrossesRect(route, rect) ? 150 : 0;
  }
  return penalty;
};

/** A label set beside its line, rather than on it, costs this much extra. */
const BESIDE_COST = 20;
/** A label off its line costs this much, plus `DETACHED_COST_PER_PX` per pixel away. */
const DETACHED_COST = 40;
const DETACHED_COST_PER_PX = 3;
/** Moving a label away from where the layout put it costs this much per pixel. */
const MOVE_COST_PER_PX = 0.5;
/**
 * A label over a bend in its own line costs this much: the line turns behind it and leaves from
 * an unexpected side.
 */
const BEND_COST = 30;

/**
 * The best spot for a label along its route: on the line (which runs behind the label's
 * background), beside it, or, when the route is too crowded or short for either, a little way
 * off it. Each spot is scored on how far it is from where the layout put the label and on what
 * it would collide with; the best scoring spot wins, which may be where the label already is.
 */
const slideLabel = (
  route: readonly C4Point[],
  label: C4Rect,
  obstacles: readonly C4Rect[],
  otherRoutes: readonly (readonly C4Point[])[],
  weighted: WeightedObstacles
): C4Rect => {
  // Moves are measured from where the label sits on its line; centring a label that has
  // drifted beside its line costs nothing.
  const own = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  const centre = labelCentredOnRoute(label, route) ? own : nearestPointOnRoute(own, route);
  const candidates: { rect: C4Rect; cost: number }[] = [];
  const add = (rect: C4Rect, extra: number) => {
    const moved = Math.hypot(
      rect.x + rect.width / 2 - centre.x,
      rect.y + rect.height / 2 - centre.y
    );
    const bend = labelOnBend(rect, route) ? BEND_COST : 0;
    candidates.push({ rect, cost: extra + bend + MOVE_COST_PER_PX * moved });
  };
  const total = routeLength(route);
  let travelled = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const vertical = Math.abs(a.x - b.x) < 0.5;
    for (let along = 0; along <= length; along += 4) {
      const fromStart = travelled + along;
      if (fromStart < LABEL_END_CLEARANCE || total - fromStart < LABEL_END_CLEARANCE) {
        continue;
      }
      const t = length === 0 ? 0 : along / length;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const onLine = {
        x: point.x - label.width / 2,
        y: point.y - label.height / 2,
        width: label.width,
        height: label.height,
      };
      add(onLine, 0);
      // Beside the line: right of or left of a vertical one, above or below a horizontal one.
      const beside = vertical
        ? [
            { ...onLine, x: point.x + 4 },
            { ...onLine, x: point.x - 4 - label.width },
          ]
        : [
            { ...onLine, y: point.y - 4 - label.height },
            { ...onLine, y: point.y + 4 },
          ];
      for (const rect of beside) {
        add(rect, BESIDE_COST);
      }
    }
    travelled += length;
  }
  candidates.sort((p, q) => p.cost - q.cost);
  const free = candidates.find(({ rect }) => !labelCollides(rect, obstacles, otherRoutes));
  if (free && free.cost <= DETACHED_COST) {
    return free.rect;
  }
  // A short or crowded route: also consider spots a little way off it.
  for (const rect of nearbySpots(route, label)) {
    add(rect, DETACHED_COST + DETACHED_COST_PER_PX * distanceToRoute(rect, route));
  }
  candidates.push({ rect: label, cost: labelOnBend(label, route) ? BEND_COST : 0 });
  let best = candidates[0];
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate.cost >= bestScore) {
      continue;
    }
    const score = candidate.cost + labelPenalty(candidate.rect, weighted);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best.rect;
};

/** How far from its route a label may be put when there is no room on it or beside it. */
const NEARBY_REACH = 60;

/** Spots for a label around a route, within `NEARBY_REACH` of it. */
const nearbySpots = (route: readonly C4Point[], label: C4Rect): C4Rect[] => {
  const spots: C4Rect[] = [];
  const middle = routeMidpoint(route);
  for (let dy = -NEARBY_REACH - label.height; dy <= NEARBY_REACH; dy += 6) {
    for (let dx = -NEARBY_REACH - label.width; dx <= NEARBY_REACH; dx += 6) {
      const rect = { x: middle.x + dx, y: middle.y + dy, width: label.width, height: label.height };
      if (distanceToRoute(rect, route) <= NEARBY_REACH) {
        spots.push(rect);
      }
    }
  }
  return spots;
};

/** The shortest distance between a rectangle and a route. */
const distanceToRoute = (rect: C4Rect, route: readonly C4Point[]): number => {
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    // Axis-aligned segment against axis-aligned box: the gap along each axis.
    const gapX = Math.max(
      0,
      rect.x - Math.max(a.x, b.x),
      Math.min(a.x, b.x) - (rect.x + rect.width)
    );
    const gapY = Math.max(
      0,
      rect.y - Math.max(a.y, b.y),
      Math.min(a.y, b.y) - (rect.y + rect.height)
    );
    best = Math.min(best, Math.hypot(gapX, gapY));
  }
  return best;
};

const centreOnLongestSegment = (route: readonly C4Point[], label: C4Rect): C4Rect => {
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < route.length - 1; i++) {
    const length = Math.hypot(route[i + 1].x - route[i].x, route[i + 1].y - route[i].y);
    if (length > bestLength) {
      bestLength = length;
      best = i;
    }
  }
  const a = route[best];
  const b = route[best + 1] ?? a;
  return {
    ...label,
    x: (a.x + b.x) / 2 - label.width / 2,
    y: (a.y + b.y) / 2 - label.height / 2,
  };
};

/**
 * Routes a side-by-side relationship across the gap the layout left for it, from the side of
 * one end that faces the other, and puts its label in the gap.
 */
const routeSideBySide = (
  rel: RefineRel,
  input: RefineInput,
  routes: Map<string, C4Point[]>,
  labels: Map<string, C4Rect>,
  titles: Iterable<C4Rect>
): void => {
  const { elements, boundaries } = input;
  const fromRect = elements.get(rel.from)?.rect ?? boundaries.get(rel.from)?.rect;
  const toRect = elements.get(rel.to)?.rect ?? boundaries.get(rel.to)?.rect;
  const gap = rel.gap!;
  if (!fromRect || !toRect) {
    return;
  }
  // Lined up along x, the route crosses the gap horizontally.
  const acrossX = (rel.gapAxis ?? (gap.height >= gap.width ? 'x' : 'y')) === 'x';
  const fromCentre = { x: fromRect.x + fromRect.width / 2, y: fromRect.y + fromRect.height / 2 };
  const toCentre = { x: toRect.x + toRect.width / 2, y: toRect.y + toRect.height / 2 };
  const facing = (rect: C4Rect, towards: C4Point, arriving: boolean): RouteEnd[] => {
    const ports = sidePorts(rect, arriving);
    return ports.filter(({ point }) =>
      acrossX
        ? towards.x > rect.x + rect.width / 2
          ? point.x >= rect.x + rect.width - 0.5
          : point.x <= rect.x + 0.5
        : towards.y > rect.y + rect.height / 2
          ? point.y >= rect.y + rect.height - 0.5
          : point.y <= rect.y + 0.5
    );
  };
  const obstacles = obstaclesFor(rel, input, labels, routes, titles);
  const avoid = [...routes.entries()].filter(([id]) => id !== rel.id).map(([, route]) => route);
  const occupied = routeEnds(avoid);
  const route =
    routeOrthogonal({
      start: facing(fromRect, toCentre, false),
      end: facing(toRect, fromCentre, true),
      obstacles,
      avoid,
      occupied,
      clearance: ROUTE_CLEARANCE,
    }) ??
    routeOrthogonal({
      start: sidePorts(fromRect, false),
      end: sidePorts(toRect, true),
      obstacles,
      avoid,
      occupied,
      clearance: ROUTE_CLEARANCE,
    });
  if (!route) {
    // Nothing gets through: a straight line between the facing sides.
    const start = acrossX
      ? { x: fromCentre.x < toCentre.x ? fromRect.x + fromRect.width : fromRect.x, y: fromCentre.y }
      : {
          x: fromCentre.x,
          y: fromCentre.y < toCentre.y ? fromRect.y + fromRect.height : fromRect.y,
        };
    const end = acrossX ? { x: gap.x + gap.width / 2, y: start.y } : { x: start.x, y: gap.y };
    routes.set(rel.id, [start, end]);
    return;
  }
  routes.set(rel.id, route);
  const label = labels.get(rel.id);
  if (label) {
    // Centre the label where the route crosses the middle of the gap.
    const middle = acrossX ? gap.x + gap.width / 2 : gap.y + gap.height / 2;
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      const spans = acrossX
        ? Math.min(a.x, b.x) <= middle && Math.max(a.x, b.x) >= middle && Math.abs(a.y - b.y) < 0.5
        : Math.min(a.y, b.y) <= middle && Math.max(a.y, b.y) >= middle && Math.abs(a.x - b.x) < 0.5;
      if (spans) {
        const centre = acrossX ? { x: middle, y: a.y } : { x: a.x, y: middle };
        labels.set(rel.id, {
          ...label,
          x: centre.x - label.width / 2,
          y: centre.y - label.height / 2,
        });
        return;
      }
    }
    labels.set(rel.id, centreOnLongestSegment(route, label));
  }
};

/**
 * Routes a relationship between a boundary and something inside it: from the inner end out to
 * the boundary's own border, on the inside.
 */
const routeNested = (
  rel: RefineRel,
  input: RefineInput,
  routes: Map<string, C4Point[]>,
  labels: Map<string, C4Rect>,
  titles: Iterable<C4Rect>
): void => {
  const { elements, boundaries } = input;
  const fromRect = elements.get(rel.from)?.rect ?? boundaries.get(rel.from)?.rect;
  const toRect = elements.get(rel.to)?.rect ?? boundaries.get(rel.to)?.rect;
  if (!fromRect || !toRect) {
    return;
  }
  // The outer end is the boundary that contains the other end.
  const fromOuter = ancestorsOf(
    boundaries,
    elements.get(rel.to)?.parent ?? boundaries.get(rel.to)?.parent
  ).has(rel.from);
  const obstacles = obstaclesFor(rel, input, labels, routes, titles);
  const avoid = [...routes.entries()].filter(([id]) => id !== rel.id).map(([, route]) => route);
  // A port on the outer boundary's border, approached or left from inside it.
  const start = fromOuter ? sidePorts(fromRect, true) : sidePorts(fromRect, false);
  const end = fromOuter ? sidePorts(toRect, true) : sidePorts(toRect, false);
  const route = routeOrthogonal({
    start,
    end,
    obstacles,
    avoid,
    occupied: routeEnds(avoid),
    clearance: ROUTE_CLEARANCE,
  });
  if (!route) {
    return;
  }
  routes.set(rel.id, route);
  const label = labels.get(rel.id);
  if (label) {
    labels.set(rel.id, centreOnLongestSegment(route, label));
  }
};

/** Where the given routes start and end. */
const routeEnds = (routes: readonly (readonly C4Point[])[]): C4Point[] =>
  routes.flatMap((route) => (route.length > 0 ? [route[0], route[route.length - 1]] : []));

/** What a route for `rel` must stay clear of. */
const obstaclesFor = (
  rel: RefineRel,
  input: RefineInput,
  labels: Map<string, C4Rect>,
  _routes: Map<string, C4Point[]>,
  titles: Iterable<C4Rect> = []
): C4Rect[] => {
  const { elements, boundaries } = input;
  const related = new Set([
    ...ancestorsOf(boundaries, elements.get(rel.from)?.parent ?? rel.from),
    ...ancestorsOf(boundaries, elements.get(rel.to)?.parent ?? rel.to),
  ]);
  const obstacles: C4Rect[] = [];
  for (const [alias, element] of elements) {
    if (alias !== rel.from && alias !== rel.to) {
      obstacles.push(element.rect);
    }
  }
  for (const [alias, boundary] of boundaries) {
    if (!related.has(alias) && alias !== rel.from && alias !== rel.to) {
      obstacles.push(boundary.rect);
    }
  }
  obstacles.push(...titles);
  for (const [id, label] of labels) {
    if (id !== rel.id) {
      obstacles.push(label);
    }
  }
  return obstacles;
};

/** Routes a relationship afresh around everything it must not touch. */
const reroute = (
  rel: RefineRel,
  points: readonly C4Point[],
  input: RefineInput,
  routes: Map<string, C4Point[]>,
  labels: Map<string, C4Rect>,
  titles: Map<string, C4Rect>
): C4Point[] | undefined => {
  const { elements, boundaries } = input;
  const obstacles = obstaclesFor(rel, input, labels, routes, titles.values());
  const avoid = [...routes.entries()].filter(([id]) => id !== rel.id).map(([, route]) => route);
  // The route may leave and enter anywhere on the two boxes, where it does now included.
  const start = points[0];
  const end = points[points.length - 1];
  const current = {
    start: { point: start, heading: headingOf(start, points[1]) } as RouteEnd,
    end: { point: end, heading: headingOf(points[points.length - 2], end) } as RouteEnd,
  };
  const fromRect = elements.get(rel.from)?.rect ?? boundaries.get(rel.from)?.rect;
  const toRect = elements.get(rel.to)?.rect ?? boundaries.get(rel.to)?.rect;
  const occupied = routeEnds(avoid);
  return routeOrthogonal({
    start: [current.start, ...(fromRect ? sidePorts(fromRect, false) : [])],
    end: [current.end, ...(toRect ? sidePorts(toRect, true) : [])],
    obstacles,
    avoid,
    occupied,
    clearance: ROUTE_CLEARANCE,
  });
};

/**
 * Finds stretches where two routes run along each other, too close to tell apart, and slides
 * one of the two segments aside to a spot that keeps clear of every other route and element.
 */
const separateParallelRuns = (
  rels: readonly RefineRel[],
  routes: Map<string, C4Point[]>,
  labels: Map<string, C4Rect>,
  elementRects: readonly C4Rect[],
  titles: readonly C4Rect[],
  rectOf: (alias: string) => C4Rect | undefined,
  input: RefineInput
): void => {
  const context: RouteContext = { rels, routes, labels, elementRects, titles, rectOf, input };
  for (let i = 0; i < rels.length; i++) {
    for (let j = i + 1; j < rels.length; j++) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const first = routes.get(rels[i].id)!;
        const second = routes.get(rels[j].id)!;
        const clash = findParallelClash(first, second, COINCIDENT_GAP);
        if (!clash) {
          break;
        }
        const moved =
          nudgeSegment(rels[j], clash.second, rels[i], context) ||
          nudgeSegment(rels[i], clash.first, rels[j], context) ||
          rerouteApart(rels[j], rels[i], context) ||
          rerouteApart(rels[i], rels[j], context);
        if (!moved) {
          break;
        }
      }
    }
  }
};

/** Lines closer than this are drawn on top of each other, as far as a reader can tell. */
const COINCIDENT_GAP = 5;

/** The first pair of segments along which two routes run closer than `gap`, if any. */
const findParallelClash = (
  first: readonly C4Point[],
  second: readonly C4Point[],
  gap: number
): { first: number; second: number } | undefined => {
  for (let f = 0; f < first.length - 1; f++) {
    for (let s = 0; s < second.length - 1; s++) {
      if (parallelOverlap(first[f], first[f + 1], second[s], second[s + 1], gap) > 8) {
        return { first: f, second: s };
      }
    }
  }
  return undefined;
};

/** Length over which two segments run side by side, closer than `gap`. */
const parallelOverlap = (
  a1: C4Point,
  a2: C4Point,
  b1: C4Point,
  b2: C4Point,
  gap: number
): number => {
  const aVertical = Math.abs(a1.x - a2.x) < 0.5;
  const bVertical = Math.abs(b1.x - b2.x) < 0.5;
  const aHorizontal = Math.abs(a1.y - a2.y) < 0.5;
  const bHorizontal = Math.abs(b1.y - b2.y) < 0.5;
  if (aVertical && bVertical && Math.abs(a1.x - b1.x) < gap) {
    return (
      Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) -
      Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
    );
  }
  if (aHorizontal && bHorizontal && Math.abs(a1.y - b1.y) < gap) {
    return (
      Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) -
      Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
    );
  }
  return 0;
};

/**
 * Routes `rel` afresh, keeping off every other route, when sliding its segments could not part
 * it from `from`'s route. The new route is kept only if it no longer runs along `from`'s and adds
 * no other problem.
 */
const rerouteApart = (rel: RefineRel, from: RefineRel, context: RouteContext): boolean => {
  const { input, routes, labels } = context;
  const route = routes.get(rel.id)!;
  if (!input || route.length < 2 || rel.from === rel.to) {
    return false;
  }
  const before = routeIssues(rel, route, context);
  before.delete(`coincident:${from.id}`);
  const titles = [...context.titles];
  const rerouted = reroute(
    rel,
    route,
    input,
    routes,
    labels,
    new Map(titles.map((t, i) => [`${i}`, t]))
  );
  if (!rerouted || !addsNoIssue(before, routeIssues(rel, rerouted, context))) {
    return false;
  }
  // Parting two lines is not worth a detour.
  if (routeLength(rerouted) > 1.3 * routeLength(route) + 60 || rerouted.length > route.length + 2) {
    return false;
  }
  route.splice(0, route.length, ...rerouted);
  const label = labels.get(rel.id);
  if (label) {
    labels.set(rel.id, centreOnLongestSegment(rerouted, label));
  }
  return true;
};

/**
 * Slides segment `index` of `rel`'s route sideways, away from `from`'s route, to a spot that adds
 * no new problem.
 */
const nudgeSegment = (
  rel: RefineRel,
  index: number,
  from: RefineRel,
  context: RouteContext
): boolean => {
  const route = context.routes.get(rel.id)!;
  const a = route[index];
  const b = route[index + 1];
  const vertical = Math.abs(a.x - b.x) < 0.5;
  if (!vertical && Math.abs(a.y - b.y) >= 0.5) {
    return false;
  }
  const before = routeIssues(rel, route, context);
  // The point of the move: the two must no longer run on top of each other.
  before.delete(`coincident:${from.id}`);
  const current = vertical ? a.x : a.y;
  for (const step of [1, -1, 2, -2, 3, -3]) {
    const value = current + step * PARALLEL_GAP;
    const moved = route.map((point) => ({ ...point }));
    if (vertical) {
      moved[index].x = value;
      moved[index + 1].x = value;
    } else {
      moved[index].y = value;
      moved[index + 1].y = value;
    }
    if (!addsNoIssue(before, routeIssues(rel, moved, context))) {
      continue;
    }
    route.splice(0, route.length, ...moved);
    return true;
  }
  return false;
};

/** A step sideways shorter than this, between two parallel runs, reads as noise. */
const MAX_JOG = 32;

interface RouteContext {
  rels: readonly RefineRel[];
  routes: Map<string, C4Point[]>;
  labels: Map<string, C4Rect>;
  elementRects: readonly C4Rect[];
  titles: readonly C4Rect[];
  rectOf: (alias: string) => C4Rect | undefined;
  input?: RefineInput;
}

/**
 * Everything wrong with `route` as `rel`'s route, each problem with a measure of how bad it is.
 * A change to a route is acceptable when it makes none of them worse.
 */
const routeIssues = (
  rel: RefineRel,
  route: readonly C4Point[],
  context: RouteContext
): Map<string, number> => {
  const issues = new Map<string, number>();
  const note = (issue: string, amount = 1) => issues.set(issue, (issues.get(issue) ?? 0) + amount);
  const fromRect = context.rectOf(rel.from);
  const toRect = context.rectOf(rel.to);
  // Each end on the side it leaves or enters, away from the corners, measured by how far it
  // strays: an end already a pixel into a corner may not wander off its box altogether.
  const offSide = (point: C4Point, next: C4Point, rect: C4Rect | undefined) => {
    if (!rect) {
      return 0;
    }
    const vertical = Math.abs(point.x - next.x) < 0.5;
    const [value, low, high] = vertical
      ? [point.x, rect.x, rect.x + rect.width]
      : [point.y, rect.y, rect.y + rect.height];
    const margin = Math.min(16, (high - low) / 2);
    return Math.max(0, low + margin - value, value - (high - margin));
  };
  if (route.length >= 2) {
    const startOff = offSide(route[0], route[1], fromRect);
    if (startOff > 0.5) {
      note('start-off-side', startOff);
    }
    const endOff = offSide(route[route.length - 1], route[route.length - 2], toRect);
    if (endOff > 0.5) {
      note('end-off-side', endOff);
    }
  }
  // Turning straight back on itself, or nearly: two runs in opposite directions joined by a
  // step too short to see.
  for (let i = 1; i < route.length - 1; i++) {
    const a = route[i - 1];
    const b = route[i];
    const c = route[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    if (Math.abs(cross) < 0.01 && dot < 0) {
      note('u-turn');
    }
    const d = route[i + 2];
    if (d && Math.hypot(c.x - b.x, c.y - b.y) < 8) {
      const first = { x: b.x - a.x, y: b.y - a.y };
      const third = { x: d.x - c.x, y: d.y - c.y };
      if (
        first.x * third.x + first.y * third.y < 0 &&
        Math.abs(first.x * third.y - first.y * third.x) < 0.01
      ) {
        note('u-turn');
      }
    }
  }
  const ends = new Set([fromRect, toRect]);
  context.elementRects.forEach((rect, index) => {
    if (!ends.has(rect) && routeCrossesRect(route, rect)) {
      note(`element:${index}`);
    }
  });
  context.titles.forEach((title, index) => {
    if (routeCrossesRect(route, title)) {
      note(`title:${index}`);
    }
  });
  for (const other of context.rels) {
    const otherRoute = context.routes.get(other.id)!;
    // A relationship left without a route is not drawn, and neither is its label.
    if (other === rel || otherRoute.length < 2) {
      continue;
    }
    const close = sharedRunLength(route, otherRoute, PARALLEL_GAP - 1);
    if (close > 8) {
      note(`parallel:${other.id}`, close);
    }
    const coincident = sharedRunLength(route, otherRoute, COINCIDENT_GAP);
    if (coincident > 1) {
      note(`coincident:${other.id}`, coincident);
    }
    const otherLabel = context.labels.get(other.id);
    if (otherLabel && routeCrossesRect(route, otherLabel)) {
      note(`label:${other.id}`);
    }
    // Two arrowheads, or a start and an arrowhead, where two routes meet a box side by side.
    if (route.length < 2) {
      continue;
    }
    for (const [mine, theirs] of [
      [route[0], otherRoute[0]],
      [route[0], otherRoute[otherRoute.length - 1]],
      [route[route.length - 1], otherRoute[0]],
      [route[route.length - 1], otherRoute[otherRoute.length - 1]],
    ]) {
      if (Math.hypot(mine.x - theirs.x, mine.y - theirs.y) < PARALLEL_GAP) {
        note(`ends:${other.id}`);
      }
    }
  }
  return issues;
};

/** Whether `after` is nowhere worse than `before`. */
const addsNoIssue = (before: Map<string, number>, after: Map<string, number>): boolean =>
  [...after].every(([issue, amount]) => amount <= (before.get(issue) ?? 0) + 0.5);

/** Total length over which two routes run side by side, closer than `gap`. */
const sharedRunLength = (first: readonly C4Point[], second: readonly C4Point[], gap: number) => {
  let total = 0;
  for (let f = 0; f < first.length - 1; f++) {
    for (let s = 0; s < second.length - 1; s++) {
      total += Math.max(0, parallelOverlap(first[f], first[f + 1], second[s], second[s + 1], gap));
    }
  }
  return total;
};

/**
 * Straightens small sideways steps ("jogs") in routes. ELK often leaves one where a route
 * leaves its port and lines up with its label, and another where it lines up with the port it
 * enters. Each jog is taken out by moving one of the two runs it joins onto the other's line,
 * an end run sliding along the side of its box, as long as that adds no new problem.
 */
const straightenJogs = (
  rels: readonly RefineRel[],
  routes: Map<string, C4Point[]>,
  labels: Map<string, C4Rect>,
  elementRects: readonly C4Rect[],
  titles: readonly C4Rect[],
  rectOf: (alias: string) => C4Rect | undefined
): void => {
  const context: RouteContext = { rels, routes, labels, elementRects, titles, rectOf };
  for (const rel of rels) {
    for (let pass = 0; pass < 6; pass++) {
      if (!straightenOneJog(rel, context)) {
        break;
      }
    }
  }
};

const straightenOneJog = (rel: RefineRel, context: RouteContext): boolean => {
  const route = context.routes.get(rel.id)!;
  const before = routeIssues(rel, route, context);
  // A jog is segment k (short) between segments k-1 and k+1, which are parallel.
  for (let k = 1; k < route.length - 2; k++) {
    const jogLength = Math.hypot(route[k + 1].x - route[k].x, route[k + 1].y - route[k].y);
    // Even a sliver of a step shows: the rounded corners turn it into a visible kink.
    if (jogLength < 0.01 || jogLength > MAX_JOG) {
      continue;
    }
    const vertical = Math.abs(route[k - 1].x - route[k].x) < 0.5;
    const afterVertical = Math.abs(route[k + 1].x - route[k + 2].x) < 0.5;
    if (vertical !== afterVertical) {
      continue;
    }
    // Move the run before the jog onto the line of the run after it, or the other way round.
    const coordinate = (point: C4Point) => (vertical ? point.x : point.y);
    const options = [
      { indices: [k - 1, k], value: coordinate(route[k + 1]) },
      { indices: [k + 1, k + 2], value: coordinate(route[k]) },
    ];
    for (const { indices, value } of options) {
      const moved = route.map((point) => ({ ...point }));
      const shift = value - coordinate(route[indices[0]]);
      for (const i of indices) {
        if (vertical) {
          moved[i].x = value;
        } else {
          moved[i].y = value;
        }
      }
      const simplified = simplifyRoute(moved);
      if (!addsNoIssue(before, routeIssues(rel, simplified, context))) {
        continue;
      }
      // The label rides along if it sat on the run that moved.
      const label = context.labels.get(rel.id);
      if (label && !labelTouchesRoute(label, simplified)) {
        const movedLabel = vertical
          ? { ...label, x: label.x + shift }
          : { ...label, y: label.y + shift };
        if (!labelTouchesRoute(movedLabel, simplified)) {
          continue;
        }
        context.labels.set(rel.id, movedLabel);
      }
      route.splice(0, route.length, ...simplified);
      return true;
    }
  }
  return false;
};

/** Whether the route runs through the middle of the label, rather than along an edge or past it. */
const labelCentredOnRoute = (label: C4Rect, route: readonly C4Point[]): boolean =>
  routeCrossesRect(route, {
    x: label.x + label.width / 4,
    y: label.y + label.height / 4,
    width: label.width / 2,
    height: label.height / 2,
  });

/** The point of the route closest to `point`. */
const nearestPointOnRoute = (point: C4Point, route: readonly C4Point[]): C4Point => {
  let best = route[0];
  let bestDistance = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared
            )
          );
    const candidate = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
};

const labelTouchesRoute = (label: C4Rect, route: readonly C4Point[]): boolean =>
  routeCrossesRect(route, {
    x: label.x - 1,
    y: label.y - 1,
    width: label.width + 2,
    height: label.height + 2,
  });

/**
 * Makes every segment of a route exactly horizontal or vertical: one that is off by a sliver is
 * straightened, one that is genuinely slanted gets a corner.
 */
const squareUp = (route: C4Point[]): void => {
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dx < 0.01 || dy < 0.01) {
      continue;
    }
    if (dx <= 2 && dy > dx) {
      b.x = a.x;
    } else if (dy <= 2 && dx > dy) {
      b.y = a.y;
    } else {
      route.splice(i + 1, 0, { x: a.x, y: b.y });
      i++;
    }
  }
};
