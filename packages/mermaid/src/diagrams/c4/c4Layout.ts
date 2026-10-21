/**
 * Positions the elements, boundaries and relationships of a C4 diagram.
 *
 * The layout is computed from measured sizes only, without touching the DOM, so it can be tested
 * on its own. ELK's layered algorithm does the work when it is available: boundaries become
 * compound nodes, relationships become orthogonally routed edges, and every relationship label is
 * an inline edge label, so ELK reserves room for it and routes other edges around it. Builds
 * without ELK fall back to dagre.
 *
 * Two kinds of placement go beyond what the layered algorithm does by itself, and are arranged
 * per container (the diagram, or a boundary) by fixing the layer of every child:
 * - relationships with a side-by-side hint (`Rel_R` in a top-down diagram, for one) put their two
 *   ends in the same layer, in order, with room between them for the label; the layout leaves
 *   such a relationship unrouted, and reports the gap it is to cross;
 * - elements and boundaries without any relationship are arranged in rows, like the original C4
 *   renderer did: elements first, at most `elementsPerRow` to a row, then boundaries, at most
 *   `boundariesPerRow` to a row (`UpdateLayoutConfig($c4ShapeInRow, $c4BoundaryInRow)`).
 *
 * Every coordinate in the result is absolute, and every rectangle is given by its top-left corner.
 */
import { layout as dagreLayout } from 'dagre-d3-es/src/dagre/index.js';
import * as graphlib from 'dagre-d3-es/src/graphlib/index.js';
import { log } from '../../logger.js';
import { simplifyRoute } from './c4Geometry.js';
import { routeOrthogonal, sidePorts } from './c4Router.js';

export type C4Direction = 'TB' | 'BT' | 'LR' | 'RL';

export interface C4Point {
  x: number;
  y: number;
}

export interface C4Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface C4LayoutNode {
  id: string;
  width: number;
  height: number;
  /** The boundary the element is declared in, if any. */
  parent?: string;
}

export interface C4LayoutBoundary {
  id: string;
  parent?: string;
  /** Size of the title block painted in the boundary's top-left corner. */
  titleWidth: number;
  titleHeight: number;
}

export interface C4LayoutEdge {
  id: string;
  /** The end the layout places first. Already oriented, see `c4Orientation.ts`. */
  source: string;
  target: string;
  labelWidth: number;
  labelHeight: number;
  /**
   * Put the two ends side by side in one layer, `source` first, rather than `source` in an
   * earlier layer than `target`. The layout does not route such an edge.
   */
  sideBySide?: boolean;
}

export interface C4LayoutSpacing {
  /** Gap between neighbouring elements in the same layer. */
  nodeSpacing: number;
  /** Gap between consecutive layers. */
  rankSpacing: number;
  /** Gap between edges that run side by side. */
  edgeSpacing: number;
  /** Gap between edges and the elements they pass or leave. */
  edgeNodeSpacing: number;
  /** Space between a boundary's border and its contents. */
  boundaryPadding: number;
  /** Space between a boundary's title and its contents. */
  titleGap: number;
}

export interface C4LayoutGrid {
  /** Elements without relationships are arranged in rows of at most this many. */
  elementsPerRow: number;
  /** Boundaries without relationships are arranged in rows of at most this many. */
  boundariesPerRow: number;
}

export interface C4LayoutInput {
  nodes: C4LayoutNode[];
  boundaries: C4LayoutBoundary[];
  edges: C4LayoutEdge[];
  /** Every node and boundary id in declaration order. Ties in the layout follow it. */
  order: string[];
  direction: C4Direction;
  spacing: C4LayoutSpacing;
  grid?: C4LayoutGrid;
}

export interface C4EdgeLayout {
  /** The route from the layout source to the layout target, ending on the two bounding boxes. */
  points: C4Point[];
  /** Where the label goes, if the relationship has one. */
  label?: C4Rect;
}

/**
 * An edge the layout placed the ends of but did not route: a side-by-side edge, or one between a
 * boundary and something inside it.
 */
export interface C4PendingEdge {
  /** For a side-by-side edge: the space between the two boxes (or their boundaries) it crosses. */
  gap?: C4Rect;
  /** The axis the two side-by-side boxes are lined up along: `x` in a vertical diagram. */
  axis?: 'x' | 'y';
  /** Set when one end is a boundary holding the other. */
  nested?: boolean;
}

export interface C4LayoutResult {
  nodes: Map<string, C4Rect>;
  boundaries: Map<string, C4Rect>;
  /** The padding each boundary was given, which is not always the configured one. */
  boundaryPadding: Map<string, number>;
  edges: Map<string, C4EdgeLayout>;
  pending: Map<string, C4PendingEdge>;
}

// ---------------------------------------------------------------------------------------------
// Hierarchy and per-container planning
// ---------------------------------------------------------------------------------------------

const ROOT_ID = '__c4_root__';

const isVertical = (direction: C4Direction) => direction === 'TB' || direction === 'BT';

interface Hierarchy {
  /** Every node and boundary to its container: a boundary, or `ROOT_ID`. */
  parentOf: Map<string, string>;
  /** Every container to its children, in declaration order. */
  childrenOf: Map<string, string[]>;
  boundaryIds: Set<string>;
}

const buildHierarchy = (input: C4LayoutInput): Hierarchy => {
  const boundaryIds = new Set(input.boundaries.map((boundary) => boundary.id));
  const parentOf = new Map<string, string>();
  const containerOf = (parent?: string) => (parent && boundaryIds.has(parent) ? parent : ROOT_ID);
  for (const boundary of input.boundaries) {
    parentOf.set(boundary.id, containerOf(boundary.parent));
  }
  for (const node of input.nodes) {
    parentOf.set(node.id, containerOf(node.parent));
  }
  // A boundary nested in itself, directly or not, is moved to the top level.
  for (const boundary of input.boundaries) {
    const seen = new Set<string>([boundary.id]);
    let current = parentOf.get(boundary.id);
    while (current && current !== ROOT_ID) {
      if (seen.has(current)) {
        parentOf.set(boundary.id, ROOT_ID);
        break;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }
  const rank = new Map(input.order.map((id, index) => [id, index]));
  const ids = [...input.boundaries.map((b) => b.id), ...input.nodes.map((n) => n.id)];
  const sorted = ids
    .map((id, index) => ({ id, index }))
    .sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index
    )
    .map(({ id }) => id);
  const childrenOf = new Map<string, string[]>([[ROOT_ID, []]]);
  for (const id of boundaryIds) {
    childrenOf.set(id, []);
  }
  for (const id of sorted) {
    childrenOf.get(parentOf.get(id)!)!.push(id);
  }
  return { parentOf, childrenOf, boundaryIds };
};

/** `id` and every container above it, up to and including `ROOT_ID`. */
const chainOf = (hierarchy: Hierarchy, id: string): string[] => {
  const chain = [id];
  let current = hierarchy.parentOf.get(id);
  while (current) {
    chain.push(current);
    current = current === ROOT_ID ? undefined : hierarchy.parentOf.get(current);
  }
  return chain;
};

/** The child of `container` that `id` is, or is inside of. */
const liftTo = (hierarchy: Hierarchy, id: string, container: string): string | undefined => {
  let current: string | undefined = id;
  while (current && current !== ROOT_ID) {
    const parent = hierarchy.parentOf.get(current);
    if (parent === container) {
      return current;
    }
    current = parent;
  }
  return undefined;
};

/** One side-by-side pair, expressed at the container where the two meet. */
interface SideBySidePair {
  edge: C4LayoutEdge;
  container: string;
  before: string;
  after: string;
}

export interface LevelPlan {
  /** The layer of every child of the container. */
  layers: Map<string, number>;
  /** The children in the order to hand them to the layout. */
  order: string[];
  /** The side-by-side pairs at this level that the plan honours. */
  pairs: SideBySidePair[];
  /** Whether some children, without relationships, are set out in rows. */
  rows: boolean;
}

export interface LayoutPlan {
  levels: Map<string, LevelPlan>;
  /** Edges between a boundary and something inside it; routed later. */
  nested: C4LayoutEdge[];
  /** Edges for the layout engine to route, including side-by-side ones it could not honour. */
  routed: C4LayoutEdge[];
  /** Side-by-side pairs the plan honours; their edges are routed later. */
  pairs: SideBySidePair[];
  /** Extra room after a child, along its layer, to hold a side-by-side label. */
  strips: Map<string, number>;
  /** Invisible edges that keep the boxes of each planned layer level with each other. */
  phantoms: C4LayoutEdge[];
  /** The padding and title gap of every boundary. */
  insets: Map<string, BoundaryInsets>;
  hierarchy: Hierarchy;
}

export interface BoundaryInsets {
  /** Space between the boundary's border and its contents. */
  padding: number;
  /** Space between the boundary's title and its contents. */
  titleGap: number;
}

/** Room kept on either side of a side-by-side label. */
const STRIP_MARGIN = 16;

/**
 * An edge between a boundary and something inside it is drawn inside the boundary, label and
 * all, in the room the boundary's padding leaves: the layout reserves nothing else for it. Such a
 * boundary, and any boundary between it and the other end, keeps at least the default padding and
 * title gap, however tight the spacing.
 */
const NESTED_EDGE_PADDING = 20;
const NESTED_EDGE_TITLE_GAP = 14;

const boundaryInsets = (
  input: C4LayoutInput,
  hierarchy: Hierarchy,
  nestedEdges: readonly C4LayoutEdge[]
): Map<string, BoundaryInsets> => {
  const roomy = new Set<string>();
  for (const edge of nestedEdges) {
    const [inner, outer] = chainOf(hierarchy, edge.source).includes(edge.target)
      ? [edge.source, edge.target]
      : [edge.target, edge.source];
    for (const id of chainOf(hierarchy, inner).slice(1)) {
      if (id === ROOT_ID) {
        break;
      }
      roomy.add(id);
      if (id === outer) {
        break;
      }
    }
  }
  const { boundaryPadding, titleGap } = input.spacing;
  return new Map(
    input.boundaries.map(({ id }) => [
      id,
      roomy.has(id)
        ? {
            padding: Math.max(boundaryPadding, NESTED_EDGE_PADDING),
            titleGap: Math.max(titleGap, NESTED_EDGE_TITLE_GAP),
          }
        : { padding: boundaryPadding, titleGap },
    ])
  );
};

export const planLayout = (input: C4LayoutInput): LayoutPlan => {
  const hierarchy = buildHierarchy(input);
  const vertical = isVertical(input.direction);
  const grid = input.grid ?? { elementsPerRow: Infinity, boundariesPerRow: Infinity };

  // Everything an edge touches, with the boundaries around it.
  const touched = new Set<string>();
  for (const edge of input.edges) {
    for (const end of [edge.source, edge.target]) {
      if (hierarchy.parentOf.has(end)) {
        chainOf(hierarchy, end).forEach((id) => touched.add(id));
      }
    }
  }

  // Side-by-side pairs, lifted to the container where the two ends meet. An edge between a
  // boundary and something inside it is kept from the layout engine altogether.
  const routed: C4LayoutEdge[] = [];
  const nestedEdges: C4LayoutEdge[] = [];
  const candidates: SideBySidePair[] = [];
  for (const edge of input.edges) {
    const known = hierarchy.parentOf.has(edge.source) && hierarchy.parentOf.has(edge.target);
    const sourceChain = known ? chainOf(hierarchy, edge.source) : [edge.source];
    const targetChain = known ? chainOf(hierarchy, edge.target) : [edge.target];
    const nested =
      edge.source !== edge.target &&
      (sourceChain.includes(edge.target) || targetChain.includes(edge.source));
    if (nested) {
      nestedEdges.push(edge);
      continue;
    }
    if (!edge.sideBySide) {
      routed.push(edge);
      continue;
    }
    const container = sourceChain.slice(1).find((id) => targetChain.slice(1).includes(id));
    if (!container) {
      routed.push({ ...edge, sideBySide: false });
      continue;
    }
    candidates.push({
      edge,
      container,
      before: liftTo(hierarchy, edge.source, container)!,
      after: liftTo(hierarchy, edge.target, container)!,
    });
  }

  const levels = new Map<string, LevelPlan>();
  const pairs: SideBySidePair[] = [];
  for (const [container, children] of hierarchy.childrenOf) {
    const levelCandidates = candidates.filter((pair) => pair.container === container);
    const isolatedElements = children.filter(
      (id) => !touched.has(id) && !hierarchy.boundaryIds.has(id)
    );
    const isolatedBoundaries = children.filter(
      (id) => !touched.has(id) && hierarchy.boundaryIds.has(id)
    );
    const needsPlan =
      levelCandidates.length > 0 ||
      isolatedElements.length > grid.elementsPerRow ||
      isolatedBoundaries.length > grid.boundariesPerRow ||
      (isolatedElements.length > 0 && isolatedBoundaries.length > 0);
    if (!needsPlan) {
      routed.push(...levelCandidates.map((pair) => ({ ...pair.edge, sideBySide: false })));
      continue;
    }
    const plan = planLevel(
      hierarchy,
      container,
      children,
      routed,
      levelCandidates,
      isolatedElements,
      isolatedBoundaries,
      grid
    );
    levels.set(container, plan);
    pairs.push(...plan.pairs);
    // Pairs the plan could not honour are routed like any other edge.
    for (const pair of levelCandidates) {
      if (!plan.pairs.includes(pair)) {
        routed.push({ ...pair.edge, sideBySide: false });
      }
    }
  }

  const strips = new Map<string, number>();
  for (const pair of pairs) {
    const labelExtent = vertical ? pair.edge.labelWidth : pair.edge.labelHeight;
    const strip = Math.max(0, labelExtent + 2 * STRIP_MARGIN - input.spacing.nodeSpacing);
    strips.set(pair.before, Math.max(strips.get(pair.before) ?? 0, strip));
  }

  const phantoms = levelPhantoms(hierarchy, routed, levels);
  const insets = boundaryInsets(input, hierarchy, nestedEdges);
  return { levels, routed, nested: nestedEdges, pairs, strips, phantoms, insets, hierarchy };
};

/**
 * ELK gives the label of an edge a layer of its own, which pushes the box the edge enters one
 * layer further down. Two boxes planned for one layer drift apart when only one of them is
 * entered by a labelled edge, and a box with no edge at all, in a row of unrelated boxes or held
 * only by a side-by-side pair, stays behind entirely. So every box below the first layer of a
 * plan that no labelled edge enters from the layer above is given an invisible one, labelled
 * with a single pixel: from the box that already leads to it, or else from the box in the same
 * column of the layer above, which lines rows up. Every gap between two layers then holds
 * exactly one layer of labels, and the boxes of a layer stay level.
 */
const levelPhantoms = (
  hierarchy: Hierarchy,
  routed: readonly C4LayoutEdge[],
  levels: ReadonlyMap<string, LevelPlan>
): C4LayoutEdge[] => {
  const phantoms: C4LayoutEdge[] = [];
  for (const [container, level] of levels) {
    const byLayer = new Map<number, string[]>();
    for (const id of level.order) {
      const layer = level.layers.get(id) ?? 0;
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), id]);
    }
    const layers = [...byLayer.keys()].sort((a, b) => a - b);
    for (let i = 1; i < layers.length; i++) {
      const above = byLayer.get(layers[i - 1])!;
      byLayer.get(layers[i])!.forEach((box, column) => {
        const fromAbove = routed.filter(
          (edge) =>
            liftTo(hierarchy, edge.target, container) === box &&
            above.includes(liftTo(hierarchy, edge.source, container) ?? '')
        );
        if (fromAbove.some((edge) => edge.labelWidth > 0 && edge.labelHeight > 0)) {
          return;
        }
        phantoms.push({
          id: `__c4_phantom_${phantoms.length}`,
          source: fromAbove[0]?.source ?? above[Math.min(column, above.length - 1)],
          target: box,
          labelWidth: 1,
          labelHeight: 1,
        });
      });
    }
  }
  return phantoms;
};

/** Fixes the layer of every child of one container. */
const planLevel = (
  hierarchy: Hierarchy,
  container: string,
  children: string[],
  edges: readonly C4LayoutEdge[],
  candidates: SideBySidePair[],
  isolatedElements: string[],
  isolatedBoundaries: string[],
  grid: C4LayoutGrid
): LevelPlan => {
  const isolated = new Set([...isolatedElements, ...isolatedBoundaries]);
  const connected = children.filter((id) => !isolated.has(id));

  // Edges between children, and edges into and out of the container.
  const successors = new Map<string, Set<string>>(connected.map((id) => [id, new Set()]));
  const enteredFromOutside = new Set<string>();
  const leftToOutside = new Set<string>();
  for (const edge of edges) {
    const from = liftTo(hierarchy, edge.source, container);
    const to = liftTo(hierarchy, edge.target, container);
    if (from && to && from !== to) {
      successors.get(from)?.add(to);
    } else if (from && !to) {
      leftToOutside.add(from);
    } else if (!from && to) {
      enteredFromOutside.add(to);
    }
  }

  // Side-by-side pairs merge their two ends into one group, unless the flow already orders them.
  const group = new Map<string, string>(connected.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (group.get(root) !== root) {
      root = group.get(root)!;
    }
    group.set(id, root);
    return root;
  };
  const reaches = (from: string, to: string): boolean => {
    // Over the groups: does a chain of edges lead from `from`'s group to `to`'s?
    const target = find(to);
    const stack = [find(from)];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const member of connected.filter((id) => find(id) === current)) {
        for (const next of successors.get(member) ?? []) {
          const nextGroup = find(next);
          if (nextGroup === target) {
            return true;
          }
          stack.push(nextGroup);
        }
      }
    }
    return false;
  };
  const honoured: SideBySidePair[] = [];
  for (const pair of candidates) {
    if (find(pair.before) === find(pair.after)) {
      honoured.push(pair);
      continue;
    }
    if (reaches(pair.before, pair.after) || reaches(pair.after, pair.before)) {
      continue;
    }
    group.set(find(pair.after), find(pair.before));
    honoured.push(pair);
  }

  // Layers of the groups: longest path from the sources, ignoring edges that close a cycle,
  // then sources pulled down next to what they lead to.
  const groupIds = [...new Set(connected.map(find))];
  const groupSuccessors = new Map<string, Set<string>>(groupIds.map((id) => [id, new Set()]));
  for (const [from, tos] of successors) {
    for (const to of tos) {
      if (find(from) !== find(to)) {
        groupSuccessors.get(find(from))!.add(find(to));
      }
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const order: string[] = [];
  const acyclic = new Map<string, Set<string>>(groupIds.map((id) => [id, new Set()]));
  const visit = (id: string) => {
    visiting.add(id);
    for (const next of groupSuccessors.get(id)!) {
      if (visiting.has(next)) {
        continue;
      }
      acyclic.get(id)!.add(next);
      if (!done.has(next)) {
        visit(next);
      }
    }
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const id of groupIds) {
    if (!done.has(id)) {
      visit(id);
    }
  }
  const topological = order.reverse();
  const layer = new Map<string, number>(groupIds.map((id) => [id, 0]));
  for (const id of topological) {
    for (const next of acyclic.get(id)!) {
      layer.set(next, Math.max(layer.get(next)!, layer.get(id)! + 1));
    }
  }
  const predecessors = new Map<string, number>(groupIds.map((id) => [id, 0]));
  for (const tos of acyclic.values()) {
    for (const to of tos) {
      predecessors.set(to, predecessors.get(to)! + 1);
    }
  }
  for (const id of [...topological].reverse()) {
    const next = [...acyclic.get(id)!];
    if (predecessors.get(id) === 0 && next.length > 0) {
      layer.set(id, Math.max(layer.get(id)!, Math.min(...next.map((n) => layer.get(n)!)) - 1));
    }
  }
  // A child connected only to the outside goes where its connection points.
  const deepest = Math.max(0, ...layer.values());
  for (const id of groupIds) {
    const members = connected.filter((member) => find(member) === id);
    const linkedInside =
      acyclic.get(id)!.size > 0 ||
      predecessors.get(id)! > 0 ||
      members.some((member) => (successors.get(member)?.size ?? 0) > 0);
    if (!linkedInside) {
      const outOnly =
        members.some((member) => leftToOutside.has(member)) &&
        !members.some((member) => enteredFromOutside.has(member));
      layer.set(id, outOnly ? deepest : 0);
    }
  }

  const layers = new Map<string, number>();
  for (const id of connected) {
    layers.set(id, layer.get(find(id))!);
  }
  // Rows for the children without relationships: elements, then boundaries.
  isolatedElements.forEach((id, index) => {
    layers.set(id, Math.floor(index / grid.elementsPerRow));
  });
  const elementRows = Math.ceil(isolatedElements.length / grid.elementsPerRow);
  isolatedBoundaries.forEach((id, index) => {
    layers.set(id, elementRows + Math.floor(index / grid.boundariesPerRow));
  });

  // Hand the children over layer by layer. The boxes of a side-by-side group go in one piece,
  // where the first of them would go, each pair's first end before its second.
  const declared = new Map(children.map((id, index) => [id, index]));
  const sorted = [...children].sort(
    (a, b) => layers.get(a)! - layers.get(b)! || declared.get(a)! - declared.get(b)!
  );
  const handOver: string[] = [];
  const placed = new Set<string>();
  for (const id of sorted) {
    if (placed.has(id)) {
      continue;
    }
    const block = group.has(id)
      ? sorted.filter((other) => group.has(other) && find(other) === find(id))
      : [id];
    const inBlock = honoured.filter((pair) => block.includes(pair.before));
    const waiting = new Map(block.map((member) => [member, 0]));
    for (const pair of inBlock) {
      waiting.set(pair.after, waiting.get(pair.after)! + 1);
    }
    const rest = [...block];
    while (rest.length > 0) {
      // The first box no pair wants after another still to come; contradictory pairs give way.
      const next = rest.find((member) => waiting.get(member) === 0) ?? rest[0];
      rest.splice(rest.indexOf(next), 1);
      handOver.push(next);
      placed.add(next);
      for (const pair of inBlock.filter((candidate) => candidate.before === next)) {
        waiting.set(pair.after, waiting.get(pair.after)! - 1);
      }
    }
  }
  return { layers, order: handOver, pairs: honoured, rows: isolated.size > 0 };
};

// ---------------------------------------------------------------------------------------------
// ELK
// ---------------------------------------------------------------------------------------------

interface ElkLabel {
  id?: string;
  text?: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
}

interface ElkSection {
  startPoint: C4Point;
  endPoint: C4Point;
  bendPoints?: C4Point[];
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabel[];
  sections?: ElkSection[];
  container?: string;
}

export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
}

/** The part of the elkjs API this module uses. */
export interface ElkApi {
  layout(graph: ElkNode): Promise<ElkNode>;
}

const ELK_DIRECTIONS: Record<C4Direction, string> = {
  TB: 'DOWN',
  BT: 'UP',
  LR: 'RIGHT',
  RL: 'LEFT',
};

/**
 * Keeps edge attachment points away from the corners of a box: C4 elements have rounded
 * corners, and an edge ending inside the rounding would stop short of the outline.
 */
const PORT_CORNER_MARGIN = 16;
/**
 * How hard ELK tries to avoid crossings. The effort pays off in an ordinary diagram, but its
 * cost grows with the size of the graph, so a large diagram gets ELK's default instead of
 * taking many seconds.
 */
const thoroughness = (input: C4LayoutInput): number => {
  const size = input.nodes.length + input.boundaries.length + input.edges.length;
  return Math.max(7, Math.min(40, Math.round(2000 / Math.max(1, size))));
};

/** The distance between two layers of a planned level along the flow: more than any box spans. */
const LAYER_STRIDE = 100_000;

export const buildElkGraph = (
  input: C4LayoutInput,
  plan: LayoutPlan = planLayout(input),
  forceOrder: ReadonlySet<string> = new Set()
): ElkNode => {
  const { spacing, direction } = input;
  const vertical = isVertical(direction);
  const { hierarchy, strips, levels, insets } = plan;

  // With INCLUDE_CHILDREN, ELK lays out each boundary as a graph of its own and reads only the
  // options set on that boundary, so every boundary is given the same ones as the root, with
  // one exception: elkjs 0.9 crashes on a nested graph that weighs the model order while edges
  // enter it from outside, so a boundary keeps its children in declaration order outright.
  const graphOptions: Record<string, string> = {
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': String(spacing.nodeSpacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.rankSpacing),
    'elk.spacing.componentComponent': String(spacing.nodeSpacing),
    'elk.spacing.edgeNode': String(spacing.edgeNodeSpacing),
    'elk.spacing.edgeEdge': String(spacing.edgeSpacing),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(spacing.edgeNodeSpacing),
    'elk.layered.spacing.edgeEdgeBetweenLayers': String(spacing.edgeSpacing),
    'elk.spacing.edgeLabel': '0',
    'elk.spacing.labelLabel': '6',
    'elk.spacing.portsSurrounding': `[top=${PORT_CORNER_MARGIN},left=${PORT_CORNER_MARGIN},bottom=${PORT_CORNER_MARGIN},right=${PORT_CORNER_MARGIN}]`,
    'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.unnecessaryBendpoints': 'true',
    'elk.layered.mergeEdges': 'false',
    'elk.layered.thoroughness': String(thoroughness(input)),
  };
  const root: ElkNode = {
    id: ROOT_ID,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': ELK_DIRECTIONS[direction],
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      ...graphOptions,
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: [],
    edges: [],
  };

  const elkNodes = new Map<string, ElkNode>([[ROOT_ID, root]]);
  for (const boundary of input.boundaries) {
    const { padding: pad, titleGap } = insets.get(boundary.id)!;
    const strip = strips.get(boundary.id) ?? 0;
    const minWidth = boundary.titleWidth + 2 * pad + (vertical ? strip : 0);
    const minHeight = boundary.titleHeight + titleGap + 2 * pad + (vertical ? 0 : strip);
    const right = pad + (vertical ? strip : 0);
    const bottom = pad + (vertical ? 0 : strip);
    elkNodes.set(boundary.id, {
      id: boundary.id,
      children: [],
      layoutOptions: {
        ...graphOptions,
        'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
        'elk.padding': `[top=${pad + boundary.titleHeight + titleGap},left=${pad},bottom=${bottom},right=${right}]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        // elkjs 0.9 swaps the two components of a compound node's minimum size when the
        // layout runs vertically with INCLUDE_CHILDREN, so they are handed over swapped.
        'elk.nodeSize.minimum': vertical
          ? `(${minHeight},${minWidth})`
          : `(${minWidth},${minHeight})`,
      },
    });
  }
  for (const node of input.nodes) {
    const strip = strips.get(node.id) ?? 0;
    elkNodes.set(node.id, {
      id: node.id,
      width: node.width + (vertical ? strip : 0),
      height: node.height + (vertical ? 0 : strip),
    });
  }

  // A planned level fixes the layer of each child. ELK's partitions would express that, but it
  // ignores them in any graph below the root, so each child is placed along the flow instead, at
  // its layer, for interactive layering to read back; interactive cycle breaking keeps the edges
  // that run against the layers from moving anything.
  const reversedFlow = direction === 'BT' || direction === 'RL';
  for (const [container, children] of hierarchy.childrenOf) {
    const elkContainer = elkNodes.get(container)!;
    const level = levels.get(container);
    const lastLayer = level ? Math.max(0, ...level.layers.values()) : 0;
    for (const id of level?.order ?? children) {
      const elkNode = elkNodes.get(id)!;
      elkContainer.children!.push(elkNode);
      if (level) {
        const layer = level.layers.get(id) ?? 0;
        const along = (reversedFlow ? lastLayer - layer : layer) * LAYER_STRIDE;
        elkNode.x = vertical ? 0 : along;
        elkNode.y = vertical ? along : 0;
      }
    }
    if (level) {
      elkContainer.layoutOptions = {
        ...elkContainer.layoutOptions,
        'elk.layered.layering.strategy': 'INTERACTIVE',
        'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
        // Balanced placement centres a row of unconnected boxes on an average of its packings to
        // either side; packing it to the start of the row lines the rows up like a grid.
        ...(level.rows ? { 'elk.layered.nodePlacement.bk.fixedAlignment': 'LEFTDOWN' } : {}),
        ...(forceOrder.has(container)
          ? { 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' }
          : {}),
      };
    }
  }

  // ELK treats a compound node without children as a plain node, which takes the minimum size
  // the right way round, so an empty boundary is given its size directly.
  for (const boundary of input.boundaries) {
    const elkNode = elkNodes.get(boundary.id)!;
    if (elkNode.children?.length === 0) {
      const pad = insets.get(boundary.id)!.padding;
      const strip = strips.get(boundary.id) ?? 0;
      delete elkNode.children;
      delete elkNode.layoutOptions;
      elkNode.width = boundary.titleWidth + 2 * pad + (vertical ? strip : 0);
      elkNode.height = boundary.titleHeight + 2 * pad + (vertical ? 0 : strip);
    }
  }

  for (const edge of [...plan.routed, ...plan.phantoms]) {
    root.edges!.push({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      labels:
        edge.labelWidth > 0 && edge.labelHeight > 0
          ? [
              {
                id: `${edge.id}__label`,
                // ELK skips a label without text: it neither reserves room for it nor places it.
                text: edge.id,
                width: edge.labelWidth,
                height: edge.labelHeight,
                layoutOptions: {
                  'elk.edgeLabels.inline': 'true',
                  'elk.edgeLabels.placement': 'CENTER',
                },
              },
            ]
          : [],
    });
  }

  return root;
};

/** Converts ELK's parent-relative coordinates into the absolute result. */
export const readElkResult = (
  graph: ElkNode,
  input: C4LayoutInput,
  plan: LayoutPlan
): C4LayoutResult => {
  const vertical = isVertical(input.direction);
  const origins = new Map<string, C4Point>([[ROOT_ID, { x: 0, y: 0 }]]);
  const rects = new Map<string, C4Rect>();
  const visit = (node: ElkNode, origin: C4Point) => {
    for (const child of node.children ?? []) {
      const x = origin.x + (child.x ?? 0);
      const y = origin.y + (child.y ?? 0);
      origins.set(child.id, { x, y });
      // A strip reserved after a box is not part of what is drawn.
      const strip = plan.strips.get(child.id) ?? 0;
      rects.set(child.id, {
        x,
        y,
        width: (child.width ?? 0) - (vertical ? strip : 0),
        height: (child.height ?? 0) - (vertical ? 0 : strip),
      });
      visit(child, { x, y });
    }
  };
  visit(graph, { x: 0, y: 0 });

  const elkEdges: ElkEdge[] = [];
  const collectEdges = (node: ElkNode) => {
    elkEdges.push(...(node.edges ?? []));
    (node.children ?? []).forEach(collectEdges);
  };
  collectEdges(graph);
  const elkEdgeById = new Map(elkEdges.map((edge) => [edge.id, edge]));

  const result: C4LayoutResult = {
    nodes: new Map(),
    boundaries: new Map(),
    boundaryPadding: new Map([...plan.insets].map(([id, { padding }]) => [id, padding])),
    edges: new Map(),
    pending: new Map(),
  };
  for (const node of input.nodes) {
    const rect = rects.get(node.id);
    if (rect) {
      result.nodes.set(node.id, rect);
    }
  }
  for (const boundary of input.boundaries) {
    const rect = rects.get(boundary.id);
    if (rect) {
      result.boundaries.set(boundary.id, rect);
    }
  }
  for (const edge of plan.routed) {
    const elkEdge = elkEdgeById.get(edge.id);
    if (!elkEdge?.sections?.length) {
      continue;
    }
    const offset = origins.get(elkEdge.container ?? ROOT_ID) ?? { x: 0, y: 0 };
    const shift = (point: C4Point): C4Point => ({ x: point.x + offset.x, y: point.y + offset.y });
    const points: C4Point[] = [];
    for (const section of elkEdge.sections) {
      for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
        const shifted = shift(point);
        const last = points.at(-1);
        if (!last || Math.abs(last.x - shifted.x) > 0.01 || Math.abs(last.y - shifted.y) > 0.01) {
          points.push(shifted);
        }
      }
    }
    orthogonalize(points);
    // One point per bend, so the last run is a single segment.
    points.splice(0, points.length, ...simplifyRoute(points));
    pullEndsOutOfStrips(points, edge, rects, plan, vertical);
    const label = elkEdge.labels?.[0];
    result.edges.set(edge.id, {
      points,
      label:
        label?.x !== undefined && label.y !== undefined
          ? { ...shift({ x: label.x, y: label.y }), width: label.width, height: label.height }
          : undefined,
    });
  }
  for (const pair of plan.pairs) {
    const before = rects.get(pair.before);
    const after = rects.get(pair.after);
    if (!before || !after) {
      continue;
    }
    // The space between the two, as wide as the layer they share.
    const gap = vertical
      ? {
          x: before.x + before.width,
          y: Math.min(before.y, after.y),
          width: after.x - before.x - before.width,
          height:
            Math.max(before.y + before.height, after.y + after.height) -
            Math.min(before.y, after.y),
        }
      : {
          x: Math.min(before.x, after.x),
          y: before.y + before.height,
          width:
            Math.max(before.x + before.width, after.x + after.width) - Math.min(before.x, after.x),
          height: after.y - before.y - before.height,
        };
    result.pending.set(pair.edge.id, { gap, axis: vertical ? 'x' : 'y' });
  }
  for (const edge of plan.nested) {
    result.pending.set(edge.id, { nested: true });
  }
  return result;
};

/**
 * Replaces any slanted segment with two axis-aligned ones. ELK occasionally hands back a route
 * with a slanted step, around hierarchy crossings mostly. The corner goes where the route keeps
 * running straight into the neighbouring segment.
 */
export const orthogonalize = (points: C4Point[]): void => {
  const isFlat = (a: C4Point, b: C4Point) => Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (isFlat(a, b)) {
      continue;
    }
    const previous = points[i - 1];
    const next = points[i + 2];
    let verticalFirst: boolean;
    if (previous && isFlat(previous, a)) {
      // Carry on in the direction the route arrived in.
      verticalFirst = Math.abs(previous.x - a.x) < 0.5;
    } else if (next && isFlat(b, next)) {
      // Leave in the direction the route goes on in.
      verticalFirst = Math.abs(b.y - next.y) < 0.5;
    } else {
      verticalFirst = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
    }
    points.splice(i + 1, 0, verticalFirst ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
    i++;
  }
};

/** Keeps a moved route end this far from the corners of the box. */
const END_MARGIN = 16;

/**
 * ELK sees a box with a label strip reserved after it as one box, and may attach an edge to the
 * strip. Such an end is moved back onto the box that is drawn: along the side, for an end on
 * one of the two sides the strip extends, or straight back, for an end on the far side of the
 * strip. `rects` holds the drawn boxes.
 */
const pullEndsOutOfStrips = (
  points: C4Point[],
  edge: C4LayoutEdge,
  rects: Map<string, C4Rect>,
  plan: LayoutPlan,
  vertical: boolean
): void => {
  for (const [id, atStart] of [
    [edge.source, true],
    [edge.target, false],
  ] as const) {
    const strip = plan.strips.get(id) ?? 0;
    const box = rects.get(id);
    if (!strip || !box || points.length < 2) {
      continue;
    }
    const endIndex = atStart ? 0 : points.length - 1;
    const nextIndex = atStart ? 1 : points.length - 2;
    const end = points[endIndex];
    const next = points[nextIndex];
    // Along the layer the strip follows the box: past its right edge (or, laid out
    // horizontally, its bottom edge).
    const along = (point: C4Point) => (vertical ? point.x : point.y);
    const setAlong = (point: C4Point, value: number) => {
      if (vertical) {
        point.x = value;
      } else {
        point.y = value;
      }
    };
    const boxStart = vertical ? box.x : box.y;
    const boxEnd = vertical ? box.x + box.width : box.y + box.height;
    if (along(end) <= boxEnd - END_MARGIN + 0.5) {
      continue;
    }
    // The last run either lies along the layer (the end is on the far side of the strip) or
    // crosses it (the end is on one of the two sides the strip lengthens).
    const lastRunAlongLayer = vertical
      ? Math.abs(end.y - next.y) < 0.5
      : Math.abs(end.x - next.x) < 0.5;
    if (lastRunAlongLayer) {
      if (along(end) > boxEnd + 0.5) {
        // Bring the end straight back across the strip to the box.
        setAlong(end, boxEnd);
      }
      continue;
    }
    // Slide the end, and the run leading to it, back along the side.
    const target = Math.max(boxStart + END_MARGIN, boxEnd - END_MARGIN);
    if (points.length === 2) {
      // A single straight run: keep the far end where it is and step across halfway.
      const far = points[atStart ? 1 : 0];
      const middle = vertical ? (end.y + far.y) / 2 : (end.x + far.x) / 2;
      const moved = vertical ? { x: target, y: end.y } : { x: end.x, y: target };
      const bendNear = vertical ? { x: target, y: middle } : { x: middle, y: target };
      const bendFar = vertical ? { x: far.x, y: middle } : { x: middle, y: far.y };
      const route = atStart ? [moved, bendNear, bendFar, far] : [far, bendFar, bendNear, moved];
      points.splice(0, points.length, ...route);
      continue;
    }
    setAlong(end, target);
    setAlong(next, target);
  }
};

/**
 * Containers where ELK did not put a side-by-side pair next to each other, in order: the second
 * end comes first, or something else sits in the gap between them.
 */
const outOfOrderContainers = (result: C4LayoutResult, input: C4LayoutInput, plan: LayoutPlan) => {
  const vertical = isVertical(input.direction);
  const rectOf = (id: string) => result.nodes.get(id) ?? result.boundaries.get(id);
  const containers = new Set<string>();
  for (const pair of plan.pairs) {
    const before = rectOf(pair.before);
    const after = rectOf(pair.after);
    if (!before || !after) {
      continue;
    }
    if (vertical ? before.x > after.x : before.y > after.y) {
      containers.add(pair.container);
      continue;
    }
    const gap = result.pending.get(pair.edge.id)?.gap;
    const siblings = plan.hierarchy.childrenOf.get(pair.container) ?? [];
    const blocked = siblings.some((id) => {
      const rect = id === pair.before || id === pair.after ? undefined : rectOf(id);
      return (
        gap &&
        rect &&
        rect.x < gap.x + gap.width &&
        rect.x + rect.width > gap.x &&
        rect.y < gap.y + gap.height &&
        rect.y + rect.height > gap.y
      );
    });
    if (blocked) {
      containers.add(pair.container);
    }
  }
  return containers;
};

export const layoutWithElk = async (input: C4LayoutInput, elk: ElkApi): Promise<C4LayoutResult> => {
  const plan = planLayout(input);
  let result = readElkResult(await elk.layout(buildElkGraph(input, plan)), input, plan);
  // ELK keeps the order it is given unless crossings argue otherwise; insist where they did.
  const outOfOrder = outOfOrderContainers(result, input, plan);
  if (outOfOrder.size > 0) {
    try {
      result = readElkResult(await elk.layout(buildElkGraph(input, plan, outOfOrder)), input, plan);
    } catch (error) {
      // Rare elkjs failures are no reason to lose the layout already in hand.
      log.warn('C4: ELK failed to enforce the declared order', error);
    }
  }
  return result;
};

// ---------------------------------------------------------------------------------------------
// dagre
// ---------------------------------------------------------------------------------------------

interface DagreNodeLabel {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The fallback for builds without ELK. dagre's own compound layout fits a cluster tightly around
 * its contents, leaving no room for a boundary's padding and title, so each boundary is laid out
 * on its own instead, innermost first, and then takes part in its parent's layout as a box of
 * known size. dagre only places the boxes; the routes are drawn afterwards, along the grid.
 */
export const layoutWithDagre = (input: C4LayoutInput): C4LayoutResult => {
  const plan = planLayout(input);
  const { hierarchy, insets } = plan;
  const boundaryById = new Map(input.boundaries.map((boundary) => [boundary.id, boundary]));
  const padOf = (id: string) => insets.get(id)!.padding;
  const contentTop = (id: string) =>
    padOf(id) + boundaryById.get(id)!.titleHeight + insets.get(id)!.titleGap;
  const isNested = (edge: C4LayoutEdge) =>
    edge.source !== edge.target &&
    (chainOf(hierarchy, edge.source).includes(edge.target) ||
      chainOf(hierarchy, edge.target).includes(edge.source));

  // Each box's size, and its place relative to the top left of its container's contents.
  const sizes = new Map<string, { width: number; height: number }>(
    input.nodes.map(({ id, width, height }) => [id, { width, height }])
  );
  const offsets = new Map<string, C4Point>();
  const depth = (id: string) => chainOf(hierarchy, id).length;
  const innermostFirst = [...hierarchy.childrenOf.keys()].sort((a, b) => depth(b) - depth(a));
  for (const container of innermostFirst) {
    const children = hierarchy.childrenOf.get(container)!;
    const content = layoutLevelWithDagre(
      input,
      children,
      sizes,
      offsets,
      // The relationships between the children, each lifted to the children holding its ends.
      input.edges.flatMap((edge) => {
        if (isNested(edge)) {
          return [];
        }
        const from = liftTo(hierarchy, edge.source, container);
        const to = liftTo(hierarchy, edge.target, container);
        return from && to && from !== to ? [{ ...edge, source: from, target: to }] : [];
      }),
      plan.levels.get(container)?.layers
    );
    if (container !== ROOT_ID) {
      const boundary = boundaryById.get(container)!;
      const pad = padOf(container);
      sizes.set(container, {
        width: Math.max(content.width, boundary.titleWidth) + 2 * pad,
        height:
          children.length > 0
            ? content.height + contentTop(container) + pad
            : boundary.titleHeight + 2 * pad,
      });
    }
  }

  const result: C4LayoutResult = {
    nodes: new Map(),
    boundaries: new Map(),
    boundaryPadding: new Map([...insets].map(([id, { padding }]) => [id, padding])),
    edges: new Map(),
    pending: new Map(),
  };
  const place = (container: string, origin: C4Point) => {
    for (const child of hierarchy.childrenOf.get(container) ?? []) {
      const offset = offsets.get(child)!;
      const { width, height } = sizes.get(child)!;
      const rect = { x: origin.x + offset.x, y: origin.y + offset.y, width, height };
      if (hierarchy.boundaryIds.has(child)) {
        result.boundaries.set(child, rect);
        place(child, { x: rect.x + padOf(child), y: rect.y + contentTop(child) });
      } else {
        result.nodes.set(child, rect);
      }
    }
  };
  place(ROOT_ID, { x: 0, y: 0 });

  const rectOf = (id: string) => result.nodes.get(id) ?? result.boundaries.get(id);
  const routes: C4Point[][] = [];
  for (const edge of input.edges) {
    const from = rectOf(edge.source);
    const to = rectOf(edge.target);
    if (!from || !to) {
      continue;
    }
    if (isNested(edge)) {
      // Routed with the room the boundary leaves, once everything else is in place.
      result.pending.set(edge.id, { nested: true });
      continue;
    }
    const obstacles = [...result.nodes]
      .filter(([id]) => id !== edge.source && id !== edge.target)
      .map(([, rect]) => rect);
    const route =
      edge.source === edge.target
        ? selfLoop(from, isVertical(input.direction))
        : (routeOrthogonal({
            start: sidePorts(from, false),
            end: sidePorts(to, true),
            obstacles,
            avoid: routes,
            occupied: routes.flatMap((other) => [other[0], other[other.length - 1]]),
          }) ?? directRoute(from, to));
    routes.push(route);
    result.edges.set(edge.id, { points: route });
  }
  return result;
};

/**
 * Lays out the children of one container with dagre, keeping the rows a plan gives them, and
 * records where each goes relative to the top left of the container's contents. Returns the
 * size of the contents.
 */
const layoutLevelWithDagre = (
  input: C4LayoutInput,
  children: readonly string[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  offsets: Map<string, C4Point>,
  edges: readonly C4LayoutEdge[],
  layers: ReadonlyMap<string, number> | undefined
): { width: number; height: number } => {
  if (children.length === 0) {
    return { width: 0, height: 0 };
  }
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: input.direction,
    nodesep: input.spacing.nodeSpacing,
    ranksep: input.spacing.rankSpacing,
    // dagre keeps edges 20px apart where ELK keeps them 14px apart, for the routes drawn
    // afterwards; the two scale together.
    edgesep: (input.spacing.edgeSpacing * 20) / 14,
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const child of children) {
    const { width, height } = sizes.get(child)!;
    graph.setNode(child, { width, height });
  }
  for (const edge of edges) {
    graph.setEdge(
      edge.source,
      edge.target,
      { width: edge.labelWidth, height: edge.labelHeight, labelpos: 'c', minlen: 1 },
      edge.id
    );
  }
  // Each row of the plan below the one before it.
  if (layers) {
    const byLayer = new Map<number, string[]>();
    for (const child of children) {
      const layer = layers.get(child) ?? 0;
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), child]);
    }
    const ordered = [...byLayer.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      for (const above of byLayer.get(ordered[i - 1])!) {
        for (const below of byLayer.get(ordered[i])!) {
          graph.setEdge(above, below, { minlen: 1, weight: 0 }, `__row__${above}__${below}`);
        }
      }
    }
  }
  dagreLayout(graph, {});

  const rects = children.map((child) => {
    const { x, y, width, height } = graph.node(child) as DagreNodeLabel;
    return { id: child, x: x - width / 2, y: y - height / 2, width, height };
  });
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  for (const rect of rects) {
    offsets.set(rect.id, { x: rect.x - left, y: rect.y - top });
  }
  return {
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - left,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - top,
  };
};

/** A small loop out of the side of a box and back, for a relationship of a box with itself. */
const selfLoop = (rect: C4Rect, vertical: boolean): C4Point[] => {
  const reach = 24;
  const spread = 16;
  if (vertical) {
    const right = rect.x + rect.width;
    const middle = rect.y + rect.height / 2;
    return [
      { x: right, y: middle - spread },
      { x: right + reach, y: middle - spread },
      { x: right + reach, y: middle + spread },
      { x: right, y: middle + spread },
    ];
  }
  const bottom = rect.y + rect.height;
  const middle = rect.x + rect.width / 2;
  return [
    { x: middle - spread, y: bottom },
    { x: middle - spread, y: bottom + reach },
    { x: middle + spread, y: bottom + reach },
    { x: middle + spread, y: bottom },
  ];
};

/**
 * A plain route from the side of `from` facing `to` to the side of `to` facing back, for when
 * the router finds no way around the boxes; the clean-up reroutes it if it can.
 */
const directRoute = (from: C4Rect, to: C4Rect): C4Point[] => {
  const fromCentre = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCentre = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const gapX = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
  const gapY = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));
  if (gapY >= gapX) {
    const down = toCentre.y > fromCentre.y;
    const start = { x: fromCentre.x, y: down ? from.y + from.height : from.y };
    const end = { x: toCentre.x, y: down ? to.y : to.y + to.height };
    const middle = (start.y + end.y) / 2;
    return simplifyRoute([start, { x: start.x, y: middle }, { x: end.x, y: middle }, end]);
  }
  const right = toCentre.x > fromCentre.x;
  const start = { x: right ? from.x + from.width : from.x, y: fromCentre.y };
  const end = { x: right ? to.x : to.x + to.width, y: toCentre.y };
  const middle = (start.x + end.x) / 2;
  return simplifyRoute([start, { x: middle, y: start.y }, { x: middle, y: end.y }, end]);
};
