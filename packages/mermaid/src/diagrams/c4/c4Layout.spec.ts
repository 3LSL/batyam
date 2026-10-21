import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import type { C4LayoutEdge, C4LayoutInput, C4LayoutResult, C4Rect, ElkApi } from './c4Layout.js';
import { layoutWithDagre, layoutWithElk, orthogonalize, planLayout } from './c4Layout.js';

// elkjs is typed as a CommonJS module; at runtime its default export is the constructor.
const elk = new (ELK as unknown as new () => ElkApi)();

const node = (id: string, parent?: string, width = 200, height = 100) => ({
  id,
  width,
  height,
  parent,
});
const boundary = (id: string, parent?: string) => ({
  id,
  parent,
  titleWidth: 120,
  titleHeight: 30,
});
const edge = (id: string, source: string, target: string, extra: Partial<C4LayoutEdge> = {}) => ({
  id,
  source,
  target,
  labelWidth: 80,
  labelHeight: 20,
  ...extra,
});

const input = (overrides: Partial<C4LayoutInput>): C4LayoutInput => ({
  nodes: [],
  boundaries: [],
  edges: [],
  order: [],
  direction: 'TB',
  spacing: {
    nodeSpacing: 50,
    rankSpacing: 50,
    edgeSpacing: 14,
    edgeNodeSpacing: 20,
    boundaryPadding: 20,
    titleGap: 14,
  },
  ...overrides,
});

const overlaps = (a: C4Rect, b: C4Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: C4Rect, inner: C4Rect) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;
const onBorder = (point: { x: number; y: number }, rect: C4Rect) => {
  const withinX = point.x >= rect.x - 0.5 && point.x <= rect.x + rect.width + 0.5;
  const withinY = point.y >= rect.y - 0.5 && point.y <= rect.y + rect.height + 0.5;
  const onVertical =
    Math.abs(point.x - rect.x) < 0.5 || Math.abs(point.x - rect.x - rect.width) < 0.5;
  const onHorizontal =
    Math.abs(point.y - rect.y) < 0.5 || Math.abs(point.y - rect.y - rect.height) < 0.5;
  return withinX && withinY && (onVertical || onHorizontal);
};

/** The invariants every layout must keep. */
const expectSound = (layout: C4LayoutResult, layoutInput: C4LayoutInput) => {
  const nodes = [...layout.nodes.entries()];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(overlaps(nodes[i][1], nodes[j][1]), `${nodes[i][0]} overlaps ${nodes[j][0]}`).toBe(
        false
      );
    }
  }
  for (const { id, parent } of [...layoutInput.nodes, ...layoutInput.boundaries]) {
    if (parent) {
      const rect = layout.nodes.get(id) ?? layout.boundaries.get(id);
      expect(contains(layout.boundaries.get(parent)!, rect!), `${id} inside ${parent}`).toBe(true);
    }
  }
  for (const [id, { points }] of layout.edges) {
    const source = layoutInput.edges.find((e) => e.id === id)!;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${id} is orthogonal`).toBe(
        true
      );
    }
    const rectOf = (alias: string) => layout.nodes.get(alias) ?? layout.boundaries.get(alias)!;
    expect(onBorder(points[0], rectOf(source.source)), `${id} starts on its source`).toBe(true);
    expect(onBorder(points.at(-1)!, rectOf(source.target)), `${id} ends on its target`).toBe(true);
  }
};

describe('planLayout', () => {
  it('hands plain edges to the layout engine', () => {
    const plan = planLayout(
      input({ nodes: [node('a'), node('b')], edges: [edge('e', 'a', 'b')], order: ['a', 'b'] })
    );
    expect(plan.routed.map((e) => e.id)).toEqual(['e']);
    expect(plan.levels.size).toBe(0);
  });

  it('keeps an edge between a boundary and something inside it away from the engine', () => {
    const plan = planLayout(
      input({
        nodes: [node('a', 'b1')],
        boundaries: [boundary('b1')],
        edges: [edge('e', 'a', 'b1')],
      })
    );
    expect(plan.routed).toHaveLength(0);
    expect(plan.nested.map((e) => e.id)).toEqual(['e']);
  });

  it('lifts a side-by-side pair to the boundaries that meet', () => {
    const plan = planLayout(
      input({
        nodes: [node('x', 'left'), node('y', 'right')],
        boundaries: [boundary('outer'), boundary('left', 'outer'), boundary('right', 'outer')],
        edges: [edge('e', 'x', 'y', { sideBySide: true })],
        order: ['outer', 'left', 'x', 'right', 'y'],
      })
    );
    expect(plan.pairs).toHaveLength(1);
    expect(plan.pairs[0]).toMatchObject({ container: 'outer', before: 'left', after: 'right' });
    const level = plan.levels.get('outer')!;
    expect(level.layers.get('left')).toBe(level.layers.get('right'));
    expect(level.order.indexOf('left')).toBe(level.order.indexOf('right') - 1);
    // Room for the label after the first.
    expect(plan.strips.get('left')).toBeGreaterThanOrEqual(0);
  });

  it('routes a side-by-side pair normally when the flow already orders the two', () => {
    const plan = planLayout(
      input({
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          edge('e1', 'a', 'b'),
          edge('e2', 'b', 'c'),
          edge('e3', 'a', 'c', { sideBySide: true }),
        ],
        order: ['a', 'b', 'c'],
      })
    );
    expect(plan.pairs).toHaveLength(0);
    expect(plan.routed.find((e) => e.id === 'e3')?.sideBySide).toBe(false);
  });

  it('orders a chain of side-by-side pairs as one block', () => {
    // queue | primary | replica, declared in another order.
    const plan = planLayout(
      input({
        nodes: [node('web'), node('primary'), node('replica'), node('queue')],
        edges: [
          edge('e1', 'web', 'primary'),
          edge('e2', 'web', 'replica'),
          edge('e3', 'primary', 'replica', { sideBySide: true }),
          edge('e4', 'queue', 'primary', { sideBySide: true }),
        ],
        order: ['web', 'primary', 'replica', 'queue'],
      })
    );
    const level = plan.levels.get('__c4_root__')!;
    expect(level.order).toEqual(['web', 'queue', 'primary', 'replica']);
    expect(plan.pairs).toHaveLength(2);
  });

  it('keeps the default room in a boundary that holds an edge to something inside it', () => {
    // outer > mid > x, with an edge from outer to x; other > y has none.
    const tight = { ...input({}).spacing, boundaryPadding: 8, titleGap: 8 };
    const layoutInput = input({
      nodes: [node('x', 'mid'), node('y', 'other')],
      boundaries: [boundary('outer'), boundary('mid', 'outer'), boundary('other')],
      edges: [edge('n', 'outer', 'x'), edge('e', 'x', 'y')],
      order: ['outer', 'mid', 'x', 'other', 'y'],
      spacing: tight,
    });
    const { insets } = planLayout(layoutInput);
    expect(insets.get('outer')).toEqual({ padding: 20, titleGap: 14 });
    expect(insets.get('mid')).toEqual({ padding: 20, titleGap: 14 });
    expect(insets.get('other')).toEqual({ padding: 8, titleGap: 8 });
    // Wider than the default, the configured room stays.
    const roomy = planLayout({
      ...layoutInput,
      spacing: { ...tight, boundaryPadding: 30, titleGap: 25 },
    });
    expect(roomy.insets.get('outer')).toEqual({ padding: 30, titleGap: 25 });
  });

  it('arranges elements without relationships in rows, then boundaries below them', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const plan = planLayout(
      input({
        nodes: ids.map((id) => node(id)),
        boundaries: [boundary('b1'), boundary('b2')],
        order: [...ids, 'b1', 'b2'],
        grid: { elementsPerRow: 4, boundariesPerRow: 1 },
      })
    );
    const layers = plan.levels.get('__c4_root__')!.layers;
    expect(ids.map((id) => layers.get(id))).toEqual([0, 0, 0, 0, 1, 1]);
    expect(layers.get('b1')).toBe(2);
    expect(layers.get('b2')).toBe(3);
  });
});

describe('layoutWithElk', () => {
  it('lays a chain out top to bottom', async () => {
    const layoutInput = input({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      order: ['a', 'b', 'c'],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const y = (id: string) => layout.nodes.get(id)!.y;
    expect(y('a')).toBeLessThan(y('b'));
    expect(y('b')).toBeLessThan(y('c'));
    expectSound(layout, layoutInput);
  });

  it('lays a chain out left to right', async () => {
    const layoutInput = input({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')],
      order: ['a', 'b'],
      direction: 'LR',
    });
    const layout = await layoutWithElk(layoutInput, elk);
    expect(layout.nodes.get('a')!.x).toBeLessThan(layout.nodes.get('b')!.x);
    expectSound(layout, layoutInput);
  });

  it('leaves room in a boundary for its title above what it holds', async () => {
    const layoutInput = input({
      nodes: [node('p'), node('a', 'sys'), node('b', 'sys')],
      boundaries: [boundary('sys')],
      edges: [edge('e1', 'p', 'a'), edge('e2', 'a', 'b')],
      order: ['p', 'sys', 'a', 'b'],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const frame = layout.boundaries.get('sys')!;
    const top = Math.min(layout.nodes.get('a')!.y, layout.nodes.get('b')!.y);
    expect(top - frame.y).toBeGreaterThanOrEqual(20 + 30 + 14 - 0.5);
    expectSound(layout, layoutInput);
  });

  it('labels every routed edge', async () => {
    const layoutInput = input({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')],
      order: ['a', 'b'],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const label = layout.edges.get('e1')!.label!;
    expect(label.width).toBe(80);
    expect(label.height).toBe(20);
    // On the line, between the two.
    expect(label.y).toBeGreaterThan(layout.nodes.get('a')!.y + 100);
    expect(label.y + label.height).toBeLessThan(layout.nodes.get('b')!.y);
  });

  it('puts a side-by-side pair in one layer, in order, with a gap for the label', async () => {
    const layoutInput = input({
      nodes: [node('top'), node('a'), node('b')],
      edges: [
        edge('e1', 'top', 'a'),
        edge('e2', 'top', 'b'),
        edge('e3', 'b', 'a', { sideBySide: true, labelWidth: 150 }),
      ],
      order: ['top', 'a', 'b'],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const a = layout.nodes.get('a')!;
    const b = layout.nodes.get('b')!;
    expect(b.y).toBe(a.y);
    expect(b.x + b.width).toBeLessThanOrEqual(a.x);
    const gap = layout.pending.get('e3')!.gap!;
    expect(gap.width).toBeGreaterThanOrEqual(150);
    expect(layout.edges.has('e3')).toBe(false);
    expectSound(layout, layoutInput);
  });

  it('arranges unconnected elements in rows', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const layoutInput = input({
      nodes: ids.map((id) => node(id)),
      order: ids,
      grid: { elementsPerRow: 4, boundariesPerRow: 2 },
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const rows = new Set(ids.map((id) => Math.round(layout.nodes.get(id)!.y)));
    expect(rows.size).toBe(2);
    expectSound(layout, layoutInput);
  });

  it('gives an empty boundary the size of its title', async () => {
    const layoutInput = input({ boundaries: [boundary('empty')], order: ['empty'] });
    const layout = await layoutWithElk(layoutInput, elk);
    const frame = layout.boundaries.get('empty')!;
    expect(frame.width).toBe(120 + 40);
    expect(frame.height).toBe(30 + 40);
  });

  it('spaces and orders what a boundary holds like the top level', async () => {
    const ids = ['a', 'b', 'c'];
    const layoutInput = input({
      nodes: [node('user'), ...ids.map((id) => node(id, 'sys'))],
      boundaries: [boundary('sys')],
      edges: ids.map((id) => edge(`e-${id}`, 'user', id)),
      order: ['user', 'sys', ...ids],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const [a, b, c] = ids.map((id) => layout.nodes.get(id)!);
    // In declaration order, the configured spacing apart.
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(b.x - (a.x + a.width)).toBeCloseTo(50, 0);
    expectSound(layout, layoutInput);
  });

  it('arranges unconnected elements of a nested boundary in rows, lined up at the start', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const layoutInput = input({
      nodes: [node('user'), node('api', 'sys'), ...ids.map((id) => node(id, 'sys'))],
      boundaries: [boundary('sys')],
      edges: [edge('e1', 'user', 'api')],
      order: ['user', 'sys', 'api', ...ids],
      grid: { elementsPerRow: 4, boundariesPerRow: 2 },
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const y = (id: string) => Math.round(layout.nodes.get(id)!.y);
    expect(new Set(['a', 'b', 'c', 'd'].map(y)).size).toBe(1);
    expect(y('e')).toBe(y('f'));
    expect(y('e')).toBeGreaterThan(y('a'));
    // The first row starts with `api`, used from outside; the second lines up with it.
    expect(y('api')).toBe(y('a'));
    expect(layout.nodes.get('e')!.x).toBeCloseTo(layout.nodes.get('api')!.x, 0);
    expectSound(layout, layoutInput);
  });

  it('puts unconnected boundaries below the elements in a nested boundary', async () => {
    // The shape of the context diagram in the docs: two systems used from outside, one unused
    // database and two unused boundaries inside an enterprise.
    const layoutInput = input({
      nodes: [
        node('bank'),
        node('mainframe', 'enterprise'),
        node('mail', 'enterprise'),
        node('db', 'enterprise'),
        node('x', 'b2'),
        node('y', 'b3'),
      ],
      boundaries: [
        boundary('enterprise'),
        boundary('b2', 'enterprise'),
        boundary('b3', 'enterprise'),
      ],
      edges: [edge('e1', 'bank', 'mainframe'), edge('e2', 'bank', 'mail')],
      order: ['bank', 'enterprise', 'mainframe', 'b2', 'x', 'mail', 'db', 'b3', 'y'],
      grid: { elementsPerRow: 4, boundariesPerRow: 2 },
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const top = (id: string) => (layout.nodes.get(id) ?? layout.boundaries.get(id))!.y;
    expect(top('mail')).toBe(top('mainframe'));
    expect(top('db')).toBe(top('mainframe'));
    const firstRowBottom = Math.max(
      ...['mainframe', 'mail', 'db'].map((id) => top(id) + layout.nodes.get(id)!.height)
    );
    expect(top('b2')).toBeGreaterThan(firstRowBottom);
    expect(top('b3')).toBe(top('b2'));
    expectSound(layout, layoutInput);
  });

  it('keeps a box held only by a side-by-side pair level with its partner', async () => {
    // The labelled edge into `primary` takes a layer of its own; `queue` must follow it down.
    const layoutInput = input({
      nodes: [node('web'), node('primary'), node('queue')],
      edges: [edge('e1', 'web', 'primary'), edge('e2', 'queue', 'primary', { sideBySide: true })],
      order: ['web', 'primary', 'queue'],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const queue = layout.nodes.get('queue')!;
    const primary = layout.nodes.get('primary')!;
    expect(queue.y).toBeCloseTo(primary.y, 0);
    expect(queue.x + queue.width).toBeLessThanOrEqual(primary.x);
    expectSound(layout, layoutInput);
  });

  it('keeps the rows of a plan level, whatever labels lie between them', async () => {
    const layoutInput = input({
      nodes: [
        node('user'),
        node('banking', 'bank'),
        node('mail', 'bank'),
        node('archive', 'bank'),
        node('ledger', 'core'),
        node('fraud', 'risk'),
      ],
      boundaries: [boundary('bank'), boundary('core', 'bank'), boundary('risk', 'bank')],
      edges: [edge('e1', 'user', 'banking'), edge('e2', 'banking', 'mail')],
      order: ['user', 'bank', 'banking', 'mail', 'archive', 'core', 'ledger', 'risk', 'fraud'],
      grid: { elementsPerRow: 3, boundariesPerRow: 1 },
    });
    const layout = await layoutWithElk(layoutInput, elk);
    const rect = (id: string) => (layout.nodes.get(id) ?? layout.boundaries.get(id))!;
    const middle = (id: string) => rect(id).y + rect(id).height / 2;
    // banking and archive, then mail and core (below the label of banking -> mail), then risk.
    expect(middle('archive')).toBeCloseTo(middle('banking'), 0);
    expect(middle('core')).toBeCloseTo(middle('mail'), 0);
    expect(rect('risk').y).toBeGreaterThan(rect('core').y + rect('core').height);
    expectSound(layout, layoutInput);
  });

  it.each([undefined, 'sys'])(
    'keeps lines the configured gaps apart and away from the boxes (boundary: %s)',
    async (parent) => {
      // A fan of unlabelled edges out of `hub` into four boxes below it. The lines turn in the
      // channel between the two layers, each in a lane of its own.
      const ids = ['a', 'b', 'c', 'd'];
      for (const [edgeSpacing, edgeNodeSpacing] of [
        [14, 20],
        [6, 12],
        [30, 40],
      ]) {
        const layoutInput = input({
          nodes: [node('hub', parent), ...ids.map((id) => node(id, parent))],
          boundaries: parent ? [boundary(parent)] : [],
          edges: ids.map((id) => edge(`e-${id}`, 'hub', id, { labelWidth: 0, labelHeight: 0 })),
          order: [...(parent ? [parent] : []), 'hub', ...ids],
          spacing: { ...input({}).spacing, rankSpacing: 12, edgeSpacing, edgeNodeSpacing },
        });
        const layout = await layoutWithElk(layoutInput, elk);
        expectSound(layout, layoutInput);
        const hub = layout.nodes.get('hub')!;
        const top = hub.y + hub.height;
        const bottom = Math.min(...ids.map((id) => layout.nodes.get(id)!.y));
        const lanes = new Set<number>();
        for (const { points } of layout.edges.values()) {
          for (let i = 1; i < points.length; i++) {
            if (Math.abs(points[i].y - points[i - 1].y) < 0.5) {
              lanes.add(points[i].y);
            }
          }
        }
        const sorted = [...lanes].sort((p, q) => p - q);
        expect(sorted.length).toBeGreaterThan(1);
        expect(sorted[0] - top).toBeCloseTo(edgeNodeSpacing, 1);
        expect(bottom - sorted.at(-1)!).toBeCloseTo(edgeNodeSpacing, 1);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i] - sorted[i - 1]).toBeCloseTo(edgeSpacing, 1);
        }
      }
    }
  );

  it('lays out each boundary with its own padding', async () => {
    const layoutInput = input({
      nodes: [node('x', 'mid'), node('y', 'other')],
      boundaries: [boundary('outer'), boundary('mid', 'outer'), boundary('other')],
      edges: [edge('n', 'outer', 'x'), edge('e', 'x', 'y')],
      order: ['outer', 'mid', 'x', 'other', 'y'],
      spacing: { ...input({}).spacing, boundaryPadding: 8, titleGap: 8 },
    });
    for (const layout of [await layoutWithElk(layoutInput, elk), layoutWithDagre(layoutInput)]) {
      expect(Object.fromEntries(layout.boundaryPadding)).toEqual({ outer: 20, mid: 20, other: 8 });
      const x = layout.nodes.get('x')!;
      const mid = layout.boundaries.get('mid')!;
      const y = layout.nodes.get('y')!;
      const other = layout.boundaries.get('other')!;
      expect(x.x - mid.x).toBeCloseTo(20, 0);
      expect(x.y - mid.y).toBeCloseTo(20 + 30 + 14, 0);
      expect(y.x - other.x).toBeCloseTo(8, 0);
      expect(y.y - other.y).toBeCloseTo(8 + 30 + 8, 0);
    }
  });

  it('routes an edge into a nested boundary', async () => {
    const layoutInput = input({
      nodes: [node('user'), node('api', 'inner')],
      boundaries: [boundary('outer'), boundary('inner', 'outer')],
      edges: [edge('e1', 'user', 'api'), edge('e2', 'user', 'inner')],
      order: ['user', 'outer', 'inner', 'api'],
    });
    const layout = await layoutWithElk(layoutInput, elk);
    expect(layout.edges.get('e1')!.points.length).toBeGreaterThanOrEqual(2);
    expectSound(layout, layoutInput);
  });
});

describe('layoutWithDagre', () => {
  it('lays a chain out in boundaries, with routes for every edge', () => {
    const layoutInput = input({
      nodes: [node('p'), node('a', 'sys'), node('b', 'sys')],
      boundaries: [boundary('sys')],
      edges: [edge('e1', 'p', 'a'), edge('e2', 'a', 'b'), edge('e3', 'p', 'sys')],
      order: ['p', 'sys', 'a', 'b'],
    });
    const layout = layoutWithDagre(layoutInput);
    expect(layout.nodes.get('p')!.y).toBeLessThan(layout.nodes.get('a')!.y);
    const frame = layout.boundaries.get('sys')!;
    expect(contains(frame, layout.nodes.get('a')!)).toBe(true);
    expect(contains(frame, layout.nodes.get('b')!)).toBe(true);
    for (const id of ['e1', 'e2', 'e3']) {
      expect(layout.edges.get(id)!.points.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('orthogonalize', () => {
  it('replaces a slanted step with a corner that carries on straight', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 20, y: 50 },
      { x: 60, y: 50 },
    ];
    orthogonalize(points);
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 0, y: 50 },
      { x: 20, y: 50 },
      { x: 60, y: 50 },
    ]);
  });
});
