import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../config.js';
import type { C4DiagramConfig } from '../../config.type.js';
// @ts-expect-error Vite's JSON Schema plugin supplies this module during tests.
import configSchema from '../../schemas/config.schema.yaml';
import { sanitizeDirective } from '../../utils/sanitizeDirective.js';
import { C4_SPACING_MINIMUMS, resolveC4Spacing } from './c4Spacing.js';

const schemaProperties = (
  configSchema as {
    $defs: Record<string, { properties: Record<string, { minimum?: number; default?: number }> }>;
  }
).$defs.C4DiagramConfig.properties;

const options = Object.keys(C4_SPACING_MINIMUMS) as (keyof typeof C4_SPACING_MINIMUMS)[];

/** The spacing the layout used before the options existed. */
const original = {
  nodeSpacing: 50,
  rankSpacing: 50,
  edgeSpacing: 14,
  edgeNodeSpacing: 20,
  labelWrapWidth: 200,
  boundaryPadding: 20,
  titleGap: 14,
};

describe('resolveC4Spacing', () => {
  it('gives the original spacing when no option is set', () => {
    expect(resolveC4Spacing({})).toEqual(original);
    expect(resolveC4Spacing()).toEqual(original);
  });

  it('gives the original spacing for the default config', () => {
    expect(resolveC4Spacing(defaultConfig.c4)).toEqual(original);
  });

  it('sets each gap from its own option', () => {
    expect(
      resolveC4Spacing({
        c4ShapeSpacing: 21,
        c4LayerSpacing: 22,
        c4RelSpacing: 9,
        c4RelShapeSpacing: 15,
        c4RelLabelWrapWidth: 120,
        c4BoundaryPadding: 11,
        c4BoundaryTitleGap: 10,
      })
    ).toEqual({
      nodeSpacing: 21,
      rankSpacing: 22,
      edgeSpacing: 9,
      edgeNodeSpacing: 15,
      labelWrapWidth: 120,
      boundaryPadding: 11,
      titleGap: 10,
    });
  });

  it('takes the gaps within and between layers from c4ShapeMargin unless they are set', () => {
    expect(resolveC4Spacing({ c4ShapeMargin: 30 })).toMatchObject({
      nodeSpacing: 30,
      rankSpacing: 30,
    });
    expect(resolveC4Spacing({ c4ShapeMargin: 30, c4LayerSpacing: 70 })).toMatchObject({
      nodeSpacing: 30,
      rankSpacing: 70,
    });
    expect(resolveC4Spacing({ c4ShapeMargin: 30, c4ShapeSpacing: 18 })).toMatchObject({
      nodeSpacing: 18,
      rankSpacing: 30,
    });
  });

  it('leaves c4ShapeMargin as it is, below the minimums too', () => {
    expect(resolveC4Spacing({ c4ShapeMargin: 0 })).toMatchObject({
      nodeSpacing: 0,
      rankSpacing: 0,
    });
  });

  it('raises a value below its minimum to the minimum', () => {
    const zeros = Object.fromEntries(options.map((key) => [key, 0])) as C4DiagramConfig;
    expect(resolveC4Spacing(zeros)).toEqual({
      nodeSpacing: 10,
      rankSpacing: 12,
      edgeSpacing: 6,
      edgeNodeSpacing: 12,
      labelWrapWidth: 80,
      boundaryPadding: 8,
      titleGap: 8,
    });
    expect(resolveC4Spacing({ c4RelSpacing: -40 }).edgeSpacing).toBe(6);
    // Explicitly set, the gap no longer follows c4ShapeMargin below its minimum.
    expect(resolveC4Spacing({ c4ShapeMargin: 0, c4ShapeSpacing: 0 }).nodeSpacing).toBe(10);
  });

  it('keeps elements further apart for dagre, which routes the relationships between them', () => {
    const zeros: C4DiagramConfig = { c4ShapeSpacing: 0, c4LayerSpacing: 0, c4RelSpacing: 0 };
    expect(resolveC4Spacing(zeros, { dagre: true })).toMatchObject({
      nodeSpacing: 24,
      rankSpacing: 24,
      edgeSpacing: 6,
    });
    expect(resolveC4Spacing({ c4ShapeSpacing: 40 }, { dagre: true }).nodeSpacing).toBe(40);
    expect(resolveC4Spacing({ c4ShapeMargin: 0 }, { dagre: true })).toMatchObject({
      nodeSpacing: 0,
      rankSpacing: 0,
    });
    expect(resolveC4Spacing({}, { dagre: true })).toEqual(original);
  });

  it('reads a number written as a string, and ignores what is not a number', () => {
    const config = (values: Record<string, unknown>) => values as C4DiagramConfig;
    expect(resolveC4Spacing(config({ c4RelSpacing: '9' })).edgeSpacing).toBe(9);
    expect(resolveC4Spacing(config({ c4RelSpacing: 'wide' })).edgeSpacing).toBe(14);
    expect(resolveC4Spacing(config({ c4RelSpacing: '' })).edgeSpacing).toBe(14);
    expect(resolveC4Spacing(config({ c4RelSpacing: null })).edgeSpacing).toBe(14);
    expect(resolveC4Spacing(config({ c4RelSpacing: Number.NaN })).edgeSpacing).toBe(14);
    expect(resolveC4Spacing(config({ c4ShapeMargin: 'wide' })).nodeSpacing).toBe(50);
  });

  it('agrees with the config schema on the minimums and defaults', () => {
    for (const key of options) {
      expect(schemaProperties[key]?.minimum, key).toBe(C4_SPACING_MINIMUMS[key]);
    }
    expect(schemaProperties.c4ShapeMargin.default).toBe(original.nodeSpacing);
    expect(schemaProperties.c4RelSpacing.default).toBe(original.edgeSpacing);
    expect(schemaProperties.c4RelShapeSpacing.default).toBe(original.edgeNodeSpacing);
    expect(schemaProperties.c4RelLabelWrapWidth.default).toBe(original.labelWrapWidth);
    expect(schemaProperties.c4BoundaryPadding.default).toBe(original.boundaryPadding);
    expect(schemaProperties.c4BoundaryTitleGap.default).toBe(original.titleGap);
    // These two follow c4ShapeMargin.
    expect(schemaProperties.c4ShapeSpacing.default).toBeUndefined();
    expect(schemaProperties.c4LayerSpacing.default).toBeUndefined();
  });

  it('keeps every option in the config of a diagram', () => {
    // A diagram's own config (front matter or a directive) loses any key mermaid does not know.
    const c4 = Object.fromEntries(options.map((key, index) => [key, index + 1]));
    const directive = { c4: { ...c4 } };
    sanitizeDirective(directive);
    expect(directive.c4).toEqual(c4);
  });
});
