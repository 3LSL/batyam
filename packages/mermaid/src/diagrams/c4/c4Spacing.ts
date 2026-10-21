/**
 * The spacing of a C4 diagram, read from the `c4` section of the config.
 *
 * Every option falls back to the value the layout used before the option existed, so a diagram
 * that sets none of them is drawn exactly as before. A value below its minimum is raised to it:
 * any closer, and arrowheads would disappear under labels or bend around corners, lines would
 * merge with each other or with the borders they run along, and boundary titles would lose
 * their place.
 *
 * The clearances the clean-up keeps after the layout (see `c4Refine.ts`) stay as they are: the
 * minimums are what keeps the layout from getting tighter than they are.
 */
import type { C4DiagramConfig } from '../../config.type.js';
import type { C4LayoutSpacing } from './c4Layout.js';

export interface C4Spacing extends C4LayoutSpacing {
  /** Width at which relationship labels wrap. */
  labelWrapWidth: number;
}

/** The smallest value each option takes; also given as `minimum` in the config schema. */
export const C4_SPACING_MINIMUMS = {
  /** Boxes any closer read as one. */
  c4ShapeSpacing: 10,
  /**
   * A relationship that runs straight from its label into the next layer covers this gap, and
   * its arrowhead (8px) would end up under the label.
   */
  c4LayerSpacing: 12,
  /** The clean-up takes lines closer than 5px for one line drawn twice, and pulls them apart. */
  c4RelSpacing: 6,
  /**
   * The last stretch of a line into an element is this long: any shorter and the corner before
   * it bends the arrowhead.
   */
  c4RelShapeSpacing: 12,
  /**
   * Narrower labels wrap after every word or two, and grow so tall that they crowd the lines
   * around them.
   */
  c4RelLabelWrapWidth: 80,
  /** Closer, the contents and the lines that leave them run along the border. */
  c4BoundaryPadding: 8,
  /** A boundary title keeps 6px clear of what lies below it, or it is moved off its spot. */
  c4BoundaryTitleGap: 8,
} as const satisfies Partial<Record<keyof C4DiagramConfig, number>>;

type SpacingOption = keyof typeof C4_SPACING_MINIMUMS;

/**
 * Higher minimums for a diagram laid out with dagre. dagre only places the boxes; the
 * relationships are routed afterwards, 12px clear of every box they pass, so two boxes closer
 * than twice that leave no way between them.
 */
export const C4_DAGRE_SPACING_MINIMUMS: Partial<Record<SpacingOption, number>> = {
  c4ShapeSpacing: 24,
  c4LayerSpacing: 24,
};

const DEFAULT_SHAPE_MARGIN = 50;

/** A config value as a number, if it is one. */
const numeric = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
};

export interface C4SpacingContext {
  /** The diagram is laid out with dagre rather than ELK. */
  dagre?: boolean;
}

export const resolveC4Spacing = (
  config: C4DiagramConfig = {},
  { dagre = false }: C4SpacingContext = {}
): C4Spacing => {
  const option = (key: SpacingOption, fallback: number): number => {
    const value = numeric(config[key]);
    const minimum = Math.max(
      C4_SPACING_MINIMUMS[key],
      (dagre ? C4_DAGRE_SPACING_MINIMUMS[key] : undefined) ?? 0
    );
    return value === undefined ? fallback : Math.max(minimum, value);
  };
  // `c4ShapeMargin` keeps its old meaning, and its old range: it sets the gaps within and
  // between layers that are not set on their own.
  const margin = numeric(config.c4ShapeMargin) ?? DEFAULT_SHAPE_MARGIN;
  return {
    nodeSpacing: option('c4ShapeSpacing', margin),
    rankSpacing: option('c4LayerSpacing', margin),
    edgeSpacing: option('c4RelSpacing', 14),
    edgeNodeSpacing: option('c4RelShapeSpacing', 20),
    labelWrapWidth: option('c4RelLabelWrapWidth', 200),
    boundaryPadding: option('c4BoundaryPadding', 20),
    titleGap: option('c4BoundaryTitleGap', 14),
  };
};
