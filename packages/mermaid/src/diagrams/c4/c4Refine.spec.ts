import { describe, expect, it } from 'vitest';
import type { C4Point, C4Rect } from './c4Layout.js';
import { overlapArea, routeCrossesRect } from './c4Geometry.js';
import type { RefineBoundary, RefineElement, RefineInput, RefineRel } from './c4Refine.js';
import { labelOnBend } from './c4Placement.js';
import { refineLayout } from './c4Refine.js';

const element = (rect: C4Rect, parent?: string): RefineElement => ({
  rect,
  outline: 'rect',
  parent,
});
const rel = (
  id: string,
  from: string,
  to: string,
  points: C4Point[],
  label?: C4Rect
): RefineRel => ({
  id,
  from,
  to,
  points,
  label,
  offset: { x: 0, y: 0 },
});
const refine = (
  elements: Record<string, RefineElement>,
  rels: RefineRel[],
  boundaries: Record<string, RefineBoundary> = {}
) =>
  refineLayout({
    elements: new Map(Object.entries(elements)),
    boundaries: new Map(Object.entries(boundaries)),
    rels,
    boundaryPadding: 20,
  } satisfies RefineInput);

const isOrthogonal = (route: C4Point[]) =>
  route.every(
    (point, index) =>
      index === 0 ||
      Math.abs(point.x - route[index - 1].x) < 0.01 ||
      Math.abs(point.y - route[index - 1].y) < 0.01
  );

describe('refineLayout', () => {
  it('keeps a clean route and its label as they are', () => {
    const points = [
      { x: 100, y: 100 },
      { x: 100, y: 250 },
    ];
    const label = { x: 60, y: 160, width: 80, height: 20 };
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 0, y: 250, width: 200, height: 100 }),
      },
      [rel('r', 'a', 'b', points, label)]
    );
    expect(out.routes.get('r')).toEqual(points);
    expect(out.labels.get('r')).toEqual(label);
  });

  it('routes around an element a line runs through', () => {
    const blocker = { x: 50, y: 150, width: 100, height: 60 };
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        blocker: element(blocker),
        b: element({ x: 0, y: 300, width: 200, height: 100 }),
      },
      [
        rel('r', 'a', 'b', [
          { x: 100, y: 100 },
          { x: 100, y: 300 },
        ]),
      ]
    );
    const route = out.routes.get('r')!;
    expect(routeCrossesRect(route, blocker)).toBe(false);
    expect(isOrthogonal(route)).toBe(true);
  });

  it('moves a label off an element', () => {
    const c = { x: 110, y: 150, width: 100, height: 60 };
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 0, y: 300, width: 200, height: 100 }),
        c: element(c),
      },
      [
        rel(
          'r',
          'a',
          'b',
          [
            { x: 50, y: 100 },
            { x: 50, y: 300 },
          ],
          { x: 10, y: 170, width: 120, height: 20 }
        ),
      ]
    );
    expect(overlapArea(out.labels.get('r')!, c)).toBe(0);
  });

  it('moves a label off a bend in its line, onto a straight run', () => {
    const route = [
      { x: 100, y: 100 },
      { x: 100, y: 140 },
      { x: 300, y: 140 },
      { x: 300, y: 400 },
    ];
    // Hanging from the second corner.
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 200, y: 400, width: 200, height: 100 }),
      },
      [rel('r', 'a', 'b', route, { x: 260, y: 140, width: 80, height: 20 })]
    );
    const label = out.labels.get('r')!;
    expect(labelOnBend(label, out.routes.get('r')!)).toBe(false);
    expect(routeCrossesRect(out.routes.get('r')!, label)).toBe(true);
  });

  it('pulls apart two lines drawn on top of each other', () => {
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 0, y: 300, width: 200, height: 100 }),
      },
      [
        rel('r1', 'a', 'b', [
          { x: 100, y: 100 },
          { x: 100, y: 300 },
        ]),
        rel('r2', 'a', 'b', [
          { x: 100, y: 100 },
          { x: 100, y: 300 },
        ]),
      ]
    );
    const x1 = out.routes.get('r1')![0].x;
    const x2 = out.routes.get('r2')![0].x;
    expect(Math.abs(x1 - x2)).toBeGreaterThanOrEqual(10);
  });

  it('takes out a small step near an end', () => {
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 0, y: 300, width: 200, height: 100 }),
      },
      [
        rel('r', 'a', 'b', [
          { x: 100, y: 100 },
          { x: 100, y: 120 },
          { x: 88, y: 120 },
          { x: 88, y: 300 },
        ]),
      ]
    );
    expect(out.routes.get('r')).toHaveLength(2);
  });

  it('takes out a step of a fraction of a pixel', () => {
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 0, y: 300, width: 200, height: 100 }),
      },
      [
        rel('r', 'a', 'b', [
          { x: 100.4, y: 100 },
          { x: 100.4, y: 200 },
          { x: 100, y: 200 },
          { x: 100, y: 300 },
        ]),
      ]
    );
    expect(out.routes.get('r')).toHaveLength(2);
    expect(isOrthogonal(out.routes.get('r')!)).toBe(true);
  });

  it('never straightens a route off the box it starts from', () => {
    // A short box: ELK starts the route a pixel into the corner margin, then steps down twice.
    const source = { x: 600, y: 0, width: 234, height: 41 };
    const out = refine(
      {
        a: element(source),
        b: element({ x: 0, y: 40, width: 200, height: 100 }),
      },
      [
        rel('r', 'a', 'b', [
          { x: 600, y: 26 },
          { x: 580, y: 26 },
          { x: 580, y: 49 },
          { x: 300, y: 49 },
          { x: 300, y: 71 },
          { x: 200, y: 71 },
        ]),
      ]
    );
    const start = out.routes.get('r')![0];
    expect(start.x).toBe(600);
    expect(start.y).toBeGreaterThanOrEqual(source.y);
    expect(start.y).toBeLessThanOrEqual(source.y + source.height);
  });

  it('keeps titles clear of lines, moving the line where it can', () => {
    const inner = { x: 20, y: 64, width: 216, height: 100 };
    const out = refine(
      {
        user: element({ x: 300, y: -300, width: 200, height: 100 }),
        inner: element(inner, 'sys'),
      },
      [
        rel('r', 'user', 'inner', [
          { x: 400, y: -200 },
          { x: 400, y: -40 },
          { x: 128, y: -40 },
          { x: 128, y: 64 },
        ]),
      ],
      {
        sys: {
          rect: { x: 0, y: 0, width: 256, height: 184 },
          titleAlign: 'start',
          title: { width: 150, height: 30 },
        },
      }
    );
    const title = out.titles.get('sys')!;
    expect(title.overlay).toBe(false);
    expect(routeCrossesRect(out.routes.get('r')!, title.rect)).toBe(false);
  });

  it('routes a side-by-side relationship across its gap, with the label in it', () => {
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 400, y: 0, width: 200, height: 100 }),
      },
      [
        {
          ...rel('r', 'a', 'b', [], { x: 0, y: 0, width: 120, height: 20 }),
          gap: { x: 200, y: 0, width: 200, height: 100 },
          gapAxis: 'x',
        },
      ]
    );
    const route = out.routes.get('r')!;
    expect(route[0].x).toBe(200);
    expect(route.at(-1)!.x).toBe(400);
    const label = out.labels.get('r')!;
    expect(label.x).toBeGreaterThanOrEqual(200);
    expect(label.x + label.width).toBeLessThanOrEqual(400);
  });

  it('routes a relationship to the boundary that holds its other end', () => {
    const out = refine(
      { a: element({ x: 40, y: 80, width: 200, height: 100 }, 'sys') },
      [{ ...rel('r', 'a', 'sys', []), nested: true }],
      { sys: { rect: { x: 0, y: 0, width: 400, height: 220 }, titleAlign: 'start' } }
    );
    const route = out.routes.get('r')!;
    expect(route.length).toBeGreaterThanOrEqual(2);
    const end = route.at(-1)!;
    const onFrame = end.x === 0 || end.x === 400 || end.y === 0 || end.y === 220;
    expect(onFrame).toBe(true);
  });

  it('carries on past a relationship that has no route', () => {
    // A relationship between a boundary and something inside it is left without a route when
    // there is no way through; the others are cleaned up as usual.
    const out = refine(
      {
        a: element({ x: 0, y: 0, width: 200, height: 100 }),
        b: element({ x: 0, y: 300, width: 200, height: 100 }),
      },
      [
        rel('lost', 'a', 'b', [], { x: 0, y: 0, width: 80, height: 20 }),
        rel('r', 'a', 'b', [
          { x: 100, y: 100 },
          { x: 100, y: 200 },
          { x: 104, y: 200 },
          { x: 104, y: 300 },
        ]),
      ]
    );
    expect(out.routes.get('lost')).toEqual([]);
    // The small step is still taken out.
    expect(out.routes.get('r')).toHaveLength(2);
  });

  it("puts a boundary's title at the boundary's own padding", () => {
    const frame = { x: 0, y: 0, width: 400, height: 220 };
    const out = refine({}, [], {
      own: { rect: frame, title: { width: 100, height: 30 }, titleAlign: 'start', padding: 8 },
      shared: { rect: { ...frame, x: 500 }, title: { width: 100, height: 30 }, titleAlign: 'end' },
    });
    expect(out.titles.get('own')!.rect).toMatchObject({ x: 8, y: 8 });
    expect(out.titles.get('shared')!.rect).toMatchObject({ x: 500 + 400 - 20 - 100, y: 20 });
  });
});
