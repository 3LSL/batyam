import type { Diagram } from '../../Diagram.js';
import { getConfig, getUserDefinedConfig } from '../../config.js';
import type { MermaidConfig } from '../../config.type.js';
import type { SVG, SVGGroup } from '../../diagram-api/types.js';
import { log } from '../../logger.js';
import { getDiagramElement } from '../../rendering-util/insertElementsForSize.js';
import { clear as clearEdges, insertEdge } from '../../rendering-util/rendering-elements/edges.js';
import insertMarkers from '../../rendering-util/rendering-elements/markers.js';
import {
  clear as clearNodes,
  insertNode,
  positionNode,
} from '../../rendering-util/rendering-elements/nodes.js';
import { c4LabelHelper } from '../../rendering-util/rendering-elements/shapes/c4LabelHelper.js';
import type { NonClusterNode } from '../../rendering-util/types.js';
import { configureSvgSize } from '../../setupGraphViewbox.js';
import type { D3Selection } from '../../types.js';
import { formatUrl } from '../../utils.js';
import type c4Db from './c4Db.js';
import type { C4OutlineKind } from './c4Geometry.js';
import type {
  C4Direction,
  C4LayoutEdge,
  C4LayoutInput,
  C4LayoutResult,
  C4Point,
  C4Rect,
  ElkApi,
} from './c4Layout.js';
import { layoutWithDagre, layoutWithElk } from './c4Layout.js';
import type { C4RelPlan } from './c4Orientation.js';
import { planRelationships } from './c4Orientation.js';
import type { RefineBoundary, RefineElement, RefineRel } from './c4Refine.js';
import { refineLayout } from './c4Refine.js';
import { asColor, buildC4Node, resolveNodeShape } from './c4ShapeAdapter.js';
import { resolveC4Spacing } from './c4Spacing.js';
import type { C4Boundary, C4Rel, C4Shape } from './c4Types.js';

type C4DB = typeof c4Db;
type Group = D3Selection<SVGGElement>;

/** Corner radius of a boundary. */
const BOUNDARY_RADIUS = 6;
/** Breathing room around a relationship label, inside its background. */
const LABEL_PADDING = 3;
/** Width at which a boundary title wraps. */
const TITLE_WRAP_WIDTH = 360;
/** Corner radius of the rounded C4 boxes, as set inline by `buildC4Node`. */
const ELEMENT_RADIUS = 12;
/** Gap between the diagram title and the diagram. */
const TITLE_GAP = 24;

interface ElementView {
  shape: C4Shape;
  node: NonClusterNode;
  outline: C4OutlineKind;
}

interface BoundaryView {
  boundary: C4Boundary;
  group: Group;
  title?: { group: Group; box: DOMRect };
}

interface RelView {
  rel: C4Rel;
  id: string;
  /** How the layout treats it; see `c4Orientation.ts`. */
  plan: C4RelPlan;
  label?: { group: Group; box: DOMRect };
}

/** The end the layout places first, and the other. */
const layoutEnds = ({ rel, plan }: RelView): [string, string] => {
  if (plan.sideBySide) {
    return [plan.sideBySide.before, plan.sideBySide.after];
  }
  return plan.reversed ? [rel.to, rel.from] : [rel.from, rel.to];
};

const outlineKind = (shape: C4Shape): C4OutlineKind => {
  switch (resolveNodeShape(shape)) {
    case 'person':
      return 'person';
    case 'cylinder':
      return 'cylinder';
    case 'h-cyl':
      return 'queue';
    case 'rounded':
    case 'fr-rect':
      return 'rounded';
    default:
      return 'rect';
  }
};

const isPersonType = (shape: C4Shape | undefined) =>
  shape?.typeC4Shape.text === 'person' || shape?.typeC4Shape.text === 'external_person';

/** The boundary type shown in brackets under a boundary's name, if any. */
export const boundaryTypeLabel = (boundary: C4Boundary): string | undefined => {
  const type = boundary.type?.text?.trim();
  if (!type) {
    return undefined;
  }
  // The grammar injects the boundary kind in capitals; a type written in the diagram is kept.
  const kinds: Record<string, string> = {
    ENTERPRISE: 'Enterprise',
    SYSTEM: 'Software System',
    CONTAINER: 'Container',
  };
  return `[${kinds[type] ?? type}]`;
};

/**
 * Loads ELK. elkjs is ~1.6 MB, so the tiny build leaves it out, as it does for the other ELK
 * layouts, and lays C4 diagrams out with dagre. The ternary on the build constant is what lets
 * the bundler drop the import: a check at run time would keep it.
 */
const loadElk = injected.includeLargeFeatures
  ? async (): Promise<ElkApi> => {
      // elkjs is CommonJS: depending on the bundler the constructor is the module's default
      // export or the default export of that.
      const elkModule = (await import('elkjs/lib/elk.bundled.js')) as unknown as {
        default: (new () => ElkApi) | { default: new () => ElkApi };
      };
      const ELK = 'default' in elkModule.default ? elkModule.default.default : elkModule.default;
      return new ELK();
    }
  : undefined;

/**
 * Draws a C4 diagram: the elements, boundary titles and relationship labels are drawn and
 * measured, the layout positions them and routes the relationships, the result is cleaned up
 * (see `c4Refine.ts`), and everything is then moved into place.
 */
export const draw = async function (_text: string, id: string, _version: string, diag: Diagram) {
  const config = getConfig();
  const c4Config = config.c4 ?? {};
  const dagre = !loadElk || getUserDefinedConfig().layout === 'dagre';
  const spacing = resolveC4Spacing(c4Config, { dagre });
  const db = diag.db as C4DB;
  const svg = getDiagramElement(id, config.securityLevel) as SVG;
  const root = svg.select<SVGGElement>('g');
  const look = config.look ?? 'classic';

  clearNodes();
  clearEdges();
  insertMarkers(root, ['point'], 'c4', id);

  const container = root.append('g').attr('class', 'c4-diagram');
  const boundaryLayer = container.append('g').attr('class', 'c4-boundaries');
  const edgeLayer = container.append('g').attr('class', 'c4-relationships edgePaths');
  const elementLayer = container.append('g').attr('class', 'c4-elements nodes');
  const labelLayer = container.append('g').attr('class', 'c4-relationship-labels');
  // Titles no line could be moved off are lifted above the lines.
  const titleOverlay = container.append('g').attr('class', 'c4-boundary-titles-overlay');

  // --- Elements ---------------------------------------------------------------------------------
  const boundaryList = db.getBoundaries().filter((boundary) => boundary.alias !== 'global');
  const boundaryAliases = new Set(boundaryList.map((boundary) => boundary.alias));
  const parentOf = (alias: string | undefined) =>
    alias && boundaryAliases.has(alias) ? alias : undefined;

  const elements = new Map<string, ElementView>();
  for (const shape of db.getC4ShapeArray()) {
    const node = buildC4Node(
      shape,
      c4Config,
      c4Config.c4ShapePadding ?? 20,
      look,
      c4Config.width ?? 216
    );
    node.domId = `${id}-${shape.alias}`;
    const link = shape.link ? formatUrl(shape.link, config) : undefined;
    if (link) {
      node.link = link;
    }
    const element = await insertNode(elementLayer as unknown as SVGGroup, node, { config });
    element.attr('data-c4-alias', shape.alias);
    const parent = parentOf(shape.parentBoundary);
    if (parent) {
      element.attr('data-c4-boundary', parent);
    }
    elements.set(shape.alias, { shape, node, outline: outlineKind(shape) });
  }

  // --- Boundaries -------------------------------------------------------------------------------
  const boundaries = new Map<string, BoundaryView>();
  for (const boundary of sortOuterFirst(boundaryList, parentOf)) {
    boundaries.set(
      boundary.alias,
      await drawBoundaryTitle(
        boundaryLayer,
        boundary,
        parentOf(boundary.parentBoundary),
        id,
        config
      )
    );
  }

  // --- Relationships ----------------------------------------------------------------------------
  const isDynamic = db.getC4Type() === 'C4Dynamic';
  const knownAlias = (alias: string) => elements.has(alias) || boundaries.has(alias);
  const rels = db.getRels().filter((rel) => {
    if (knownAlias(rel.from) && knownAlias(rel.to)) {
      return true;
    }
    log.warn(`C4: relationship "${rel.from}" -> "${rel.to}" names an undefined element; skipped`);
    return false;
  });
  const direction = db.getDirection() as C4Direction;
  const plans = planRelationships(rels, direction, db.getDeclarationOrder(), (alias) =>
    isPersonType(elements.get(alias)?.shape)
  );
  const relViews: RelView[] = [];
  for (const [index, rel] of rels.entries()) {
    const relId = `c4-rel-${index}`;
    const label = await drawRelationshipLabel(
      labelLayer,
      rel,
      isDynamic ? `${index + 1}: ` : '',
      `${id}-${relId}-label`,
      spacing.labelWrapWidth
    );
    label?.group.attr('data-c4-rel', relId);
    relViews.push({ rel, id: relId, plan: plans[index], label });
  }

  // --- Layout -----------------------------------------------------------------------------------
  const layoutInput: C4LayoutInput = {
    nodes: [...elements.values()].map(({ shape, node }) => ({
      id: shape.alias,
      width: node.width ?? 0,
      height: node.height ?? 0,
      parent: parentOf(shape.parentBoundary),
    })),
    boundaries: [...boundaries.values()].map(({ boundary, title }) => ({
      id: boundary.alias,
      parent: parentOf(boundary.parentBoundary),
      titleWidth: title?.box.width ?? 0,
      titleHeight: title?.box.height ?? 0,
    })),
    edges: relViews.map((view): C4LayoutEdge => {
      const [source, target] = layoutEnds(view);
      return {
        id: view.id,
        source,
        target,
        labelWidth: view.label ? view.label.box.width + 2 * LABEL_PADDING : 0,
        labelHeight: view.label ? view.label.box.height + 2 * LABEL_PADDING : 0,
        sideBySide: view.plan.sideBySide !== undefined,
      };
    }),
    order: [...db.getDeclarationOrder()],
    direction,
    grid: { elementsPerRow: db.getC4ShapeInRow(), boundariesPerRow: db.getC4BoundaryInRow() },
    spacing,
  };
  const layout: C4LayoutResult =
    dagre || !loadElk
      ? layoutWithDagre(layoutInput)
      : await layoutWithElk(layoutInput, await loadElk()).catch((error: unknown) => {
          // A diagram drawn with the simpler layout beats no diagram at all.
          log.warn('C4: ELK layout failed, falling back to dagre', error);
          return layoutWithDagre({
            ...layoutInput,
            spacing: resolveC4Spacing(c4Config, { dagre: true }),
          });
        });

  // --- Clean-up ---------------------------------------------------------------------------------
  const refineElements = new Map<string, RefineElement>();
  for (const { shape, outline } of elements.values()) {
    const rect = layout.nodes.get(shape.alias);
    if (rect) {
      refineElements.set(shape.alias, {
        rect,
        outline,
        radius: ELEMENT_RADIUS,
        parent: parentOf(shape.parentBoundary),
      });
    }
  }
  const refineBoundaries = new Map<string, RefineBoundary>();
  for (const { boundary, title } of boundaries.values()) {
    const rect = layout.boundaries.get(boundary.alias);
    if (rect) {
      refineBoundaries.set(boundary.alias, {
        rect,
        parent: parentOf(boundary.parentBoundary),
        title: title ? { width: title.box.width, height: title.box.height } : undefined,
        titleAlign: boundary.nodeType === 'nodeR' ? 'end' : 'start',
        padding: layout.boundaryPadding.get(boundary.alias),
      });
    }
  }
  const refineRels: RefineRel[] = [];
  const routedViews = new Map<string, RelView>();
  for (const view of relViews) {
    const edgeLayout = layout.edges.get(view.id);
    const pending = layout.pending.get(view.id);
    const labelSize = view.label
      ? {
          x: 0,
          y: 0,
          width: view.label.box.width + 2 * LABEL_PADDING,
          height: view.label.box.height + 2 * LABEL_PADDING,
        }
      : undefined;
    if (pending) {
      refineRels.push({
        id: view.id,
        from: view.rel.from,
        to: view.rel.to,
        points: [],
        label: labelSize,
        offset: labelOffset(view.rel),
        gap: pending.gap,
        gapAxis: pending.axis,
        nested: pending.nested,
      });
      routedViews.set(view.id, view);
      continue;
    }
    if (!edgeLayout || edgeLayout.points.length < 2) {
      log.warn(`C4: no route for relationship "${view.rel.from}" -> "${view.rel.to}"`);
      view.label?.group.remove();
      continue;
    }
    // From here on every route runs in its relationship's own direction, `from` to `to`.
    const reversed = layoutEnds(view)[0] !== view.rel.from;
    const points = reversed ? [...edgeLayout.points].reverse() : [...edgeLayout.points];
    const label =
      view.label && (edgeLayout.label ?? centredOn(routeMiddle(points), view.label.box));
    refineRels.push({
      id: view.id,
      from: view.rel.from,
      to: view.rel.to,
      points,
      label: label ? { ...label } : undefined,
      offset: labelOffset(view.rel),
    });
    routedViews.set(view.id, view);
  }
  const refined = refineLayout({
    elements: refineElements,
    boundaries: refineBoundaries,
    rels: refineRels,
    boundaryPadding: spacing.boundaryPadding,
  });

  // --- Paint ------------------------------------------------------------------------------------
  for (const { shape, node } of elements.values()) {
    const rect = layout.nodes.get(shape.alias);
    if (rect) {
      positionNode({ ...node, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    }
  }
  for (const view of boundaries.values()) {
    const rect = layout.boundaries.get(view.boundary.alias);
    if (rect) {
      paintBoundary(view, rect, refined.titles.get(view.boundary.alias), titleOverlay);
    }
  }
  for (const [relId, points] of refined.routes) {
    const view = routedViews.get(relId)!;
    if (points.length < 2) {
      log.warn(`C4: no route for relationship "${view.rel.from}" -> "${view.rel.to}"`);
      view.label?.group.remove();
      continue;
    }
    paintRelationship(edgeLayer, view, points, id, look);
    const labelRect = refined.labels.get(relId);
    if (view.label && labelRect) {
      placeLabel(view.label, labelRect);
    }
  }

  // --- Title and viewport -----------------------------------------------------------------------
  const title = db.getTitle();
  if (title) {
    const bounds = container.node()?.getBBox();
    if (bounds) {
      container
        .append('text')
        .attr('class', 'c4TitleText')
        .attr('x', bounds.x + bounds.width / 2)
        .attr('y', bounds.y - TITLE_GAP)
        .text(title);
    }
  }
  setupViewport(svg, c4Config.diagramMarginX ?? 50, c4Config.diagramMarginY ?? 10, c4Config);
};

const sortOuterFirst = (
  boundaries: C4Boundary[],
  parentOf: (alias: string | undefined) => string | undefined
): C4Boundary[] => {
  const byAlias = new Map(boundaries.map((boundary) => [boundary.alias, boundary]));
  const depth = (boundary: C4Boundary): number => {
    let level = 0;
    let parent = parentOf(boundary.parentBoundary);
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      level++;
      parent = parentOf(byAlias.get(parent)?.parentBoundary);
    }
    return level;
  };
  return [...boundaries].sort((a, b) => depth(a) - depth(b));
};

/** Draws a boundary's title; its frame is drawn once the layout has sized it. */
const drawBoundaryTitle = async (
  layer: Group,
  boundary: C4Boundary,
  parent: string | undefined,
  diagramId: string,
  config: MermaidConfig
): Promise<BoundaryView> => {
  const link = boundary.link ? formatUrl(boundary.link, config) : undefined;
  const outer = link ? (layer.append('a').attr('xlink:href', link) as unknown as Group) : layer;
  const isDeploymentNode = boundary.nodeType !== undefined;
  const group = outer
    .append('g')
    .attr('class', `c4-boundary${isDeploymentNode ? ' c4-deployment-node' : ''}`)
    .attr('id', `${diagramId}-${boundary.alias}`)
    .attr('data-id', boundary.alias);
  if (parent) {
    group.attr('data-c4-boundary', parent);
  }

  const name = boundary.label?.text ?? '';
  const type = boundaryTypeLabel(boundary);
  const descr = boundary.descr?.text;
  if (!name && !type && !descr) {
    return { boundary, group };
  }
  const fontColor = asColor(boundary.fontColor);
  const titleNode = {
    id: `${boundary.alias}-title`,
    domId: `${diagramId}-${boundary.alias}-title`,
    label: name,
    stereotype: type ?? '',
    description: descr ? [descr] : undefined,
    width: TITLE_WRAP_WIDTH,
    padding: 0,
    labelStyle: fontColor ? `color:${fontColor}` : undefined,
    isGroup: false,
  } as NonClusterNode;
  const { shapeSvg } = await c4LabelHelper(group, titleNode, 'c4-boundary-title', {
    align: boundary.nodeType === 'nodeR' ? 'end' : 'start',
  });
  const titleGroup = shapeSvg as unknown as Group;
  titleGroup.attr('data-c4-title-of', boundary.alias);
  const box = titleGroup.node()!.getBBox();
  return { boundary, group, title: { group: titleGroup, box } };
};

const paintBoundary = (
  view: BoundaryView,
  rect: C4Rect,
  title: { rect: C4Rect; overlay: boolean } | undefined,
  overlay: Group
) => {
  const { boundary, group } = view;
  const fill = asColor(boundary.bgColor);
  const stroke = asColor(boundary.borderColor);
  group
    .insert('rect', ':first-child')
    .attr('class', 'c4-boundary-frame')
    .attr('x', rect.x)
    .attr('y', rect.y)
    .attr('width', rect.width)
    .attr('height', rect.height)
    .attr('rx', BOUNDARY_RADIUS)
    .attr('ry', BOUNDARY_RADIUS)
    .attr(
      'style',
      [fill && `fill:${fill}`, stroke && `stroke:${stroke}`].filter(Boolean).join(';')
    );
  if (!view.title || !title) {
    return;
  }
  const { group: titleGroup, box } = view.title;
  titleGroup.attr('transform', `translate(${title.rect.x - box.x}, ${title.rect.y - box.y})`);
  if (title.overlay) {
    // No line could be moved off the title and it had nowhere else to go: back it, and lift it
    // above the lines, which then pass behind it.
    titleGroup
      .insert('rect', ':first-child')
      .attr('class', 'c4-boundary-title-bg')
      .attr('x', box.x - 2)
      .attr('y', box.y - 1)
      .attr('width', box.width + 4)
      .attr('height', box.height + 2);
    overlay.node()?.appendChild(titleGroup.node()!);
  }
};

/** Draws a relationship's label, to be measured and later moved into place. */
const drawRelationshipLabel = async (
  layer: Group,
  rel: C4Rel,
  prefix: string,
  domId: string,
  wrapWidth: number
): Promise<RelView['label']> => {
  const name = `${prefix}${rel.label?.text ?? ''}`.trim();
  const techn = rel.techn?.text?.trim();
  const descr = rel.descr?.text?.trim();
  if (!name && !techn && !descr) {
    return undefined;
  }
  const textColor = asColor(rel.textColor);
  const labelNode = {
    id: domId,
    domId,
    label: name,
    stereotype: techn ? `[${techn}]` : '',
    description: descr ? [descr] : undefined,
    width: wrapWidth,
    padding: 0,
    labelStyle: textColor ? `color:${textColor}` : undefined,
    isGroup: false,
  } as NonClusterNode;
  const { shapeSvg } = await c4LabelHelper(layer, labelNode, 'c4-rel-label');
  const group = shapeSvg as unknown as Group;
  const box = group.node()!.getBBox();
  group
    .insert('rect', ':first-child')
    .attr('class', 'c4-rel-label-bg')
    .attr('x', box.x - LABEL_PADDING)
    .attr('y', box.y - LABEL_PADDING)
    .attr('width', box.width + 2 * LABEL_PADDING)
    .attr('height', box.height + 2 * LABEL_PADDING)
    .attr('rx', 3)
    .attr('ry', 3);
  return { group, box };
};

const labelOffset = (rel: C4Rel): C4Point => {
  const x = Number(rel.offsetX);
  const y = Number(rel.offsetY);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
};

/** Moves a label so its padded box is `rect`. */
const placeLabel = (label: NonNullable<RelView['label']>, rect: C4Rect) => {
  const x = rect.x + LABEL_PADDING - label.box.x;
  const y = rect.y + LABEL_PADDING - label.box.y;
  label.group.attr('transform', `translate(${x}, ${y})`);
};

const paintRelationship = (
  layer: Group,
  view: RelView,
  points: C4Point[],
  diagramId: string,
  look: string
) => {
  const { rel } = view;
  const lineColor = asColor(rel.lineColor);
  const bidirectional = rel.type === 'birel';
  const back = rel.type === 'rel_b';
  insertEdge(
    layer,
    {
      id: view.id,
      points,
      arrowTypeStart: bidirectional || back ? 'arrow_point' : undefined,
      arrowTypeEnd: back ? undefined : 'arrow_point',
      classes: 'c4-rel',
      style: lineColor ? [`stroke:${lineColor}`] : [],
      thickness: 'normal',
      pattern: 'solid',
      curve: 'rounded',
      look,
    },
    new Map(),
    'c4',
    {},
    {},
    diagramId,
    true,
    'c4'
  );
  layer
    .select(`[id="${diagramId}-${view.id}"]`)
    .attr('data-c4-from', rel.from)
    .attr('data-c4-to', rel.to);
};

const routeMiddle = (points: C4Point[]): C4Point => {
  const middle = Math.floor((points.length - 1) / 2);
  const a = points[middle];
  const b = points[middle + 1] ?? a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

const centredOn = (point: C4Point, box: DOMRect): C4Rect => ({
  x: point.x - box.width / 2 - LABEL_PADDING,
  y: point.y - box.height / 2 - LABEL_PADDING,
  width: box.width + 2 * LABEL_PADDING,
  height: box.height + 2 * LABEL_PADDING,
});

const setupViewport = (
  svg: SVG,
  marginX: number,
  marginY: number,
  c4Config: NonNullable<MermaidConfig['c4']>
) => {
  const bounds = svg.node()?.getBBox() ?? { x: 0, y: 0, width: 0, height: 0 };
  const width = bounds.width + 2 * marginX;
  const height = bounds.height + 2 * marginY;
  configureSvgSize(svg, height, width, c4Config.useMaxWidth ?? true);
  svg.attr('viewBox', `${bounds.x - marginX} ${bounds.y - marginY} ${width} ${height}`);
};

export default { draw };
