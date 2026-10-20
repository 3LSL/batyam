import { describe, expect, it } from 'vitest';
import type { C4Point } from './c4Layout.js';
import { routeCrossesRect } from './c4Geometry.js';
import type { AdjustableRoute } from './c4Placement.js';
import { applyLabelOffset, labelOnBend, placeTitle, routeAroundTitles } from './c4Placement.js';

const frame = { x: 0, y: 0, width: 500, height: 300 };
const title = { width: 150, height: 30 };
const vertical = (x: number, y1 = -50, y2 = 350): C4Point[] => [
  { x, y: y1 },
  { x, y: y2 },
];

describe('placeTitle', () => {
  it('puts the title in the top-left corner when nothing is there', () => {
    expect(placeTitle(frame, title, 20, 'start', [], [])).toEqual({ x: 20, y: 20, clear: true });
  });

  it('puts the title in the top-right corner for a right-aligned boundary', () => {
    expect(placeTitle(frame, title, 20, 'end', [], [])).toEqual({ x: 330, y: 20, clear: true });
  });

  it('steps past a line that runs through the corner', () => {
    const placement = placeTitle(frame, title, 20, 'start', [vertical(100)], []);
    expect(placement.clear).toBe(true);
    expect(placement.x).toBeGreaterThan(100);
    expect(routeCrossesRect(vertical(100), { x: placement.x, y: placement.y, ...title })).toBe(
      false
    );
  });

  it('says so when no stretch of the strip is free', () => {
    // Lines at 100, 230 and 360 leave no stretch as wide as the title.
    const lines = [vertical(100), vertical(230), vertical(360)];
    const placement = placeTitle(frame, title, 20, 'start', lines, []);
    expect(placement).toEqual({ x: 20, y: 20, clear: false });
  });

  it('keeps clear of labels and elements in the strip', () => {
    const label = { x: 15, y: 25, width: 100, height: 20 };
    const placement = placeTitle(frame, title, 20, 'start', [], [label]);
    expect(placement.x).toBeGreaterThanOrEqual(115);
  });
});

describe('routeAroundTitles', () => {
  it('slides the last run of a route along its target, off the title', () => {
    const target = { x: 20, y: 64, width: 216, height: 100 };
    const titleRect = { x: 20, y: 20, width: 150, height: 30 };
    const route: AdjustableRoute = {
      points: [
        { x: 300, y: -100 },
        { x: 300, y: -40 },
        { x: 128, y: -40 },
        { x: 128, y: 64 },
      ],
      target,
    };
    routeAroundTitles([route], [titleRect], [target]);
    expect(routeCrossesRect(route.points, titleRect)).toBe(false);
    // Still ends on the top of the target, away from its corners.
    const end = route.points.at(-1)!;
    expect(end.y).toBe(64);
    expect(end.x).toBeGreaterThanOrEqual(target.x + 16);
    expect(end.x).toBeLessThanOrEqual(target.x + target.width - 16);
  });

  it('leaves a route alone when it has nowhere to go', () => {
    const target = { x: 20, y: 64, width: 150, height: 100 };
    const titleRect = { x: 20, y: 20, width: 150, height: 30 };
    const points = [
      { x: 95, y: -100 },
      { x: 95, y: 64 },
    ];
    const route: AdjustableRoute = { points: points.map((p) => ({ ...p })), target };
    routeAroundTitles([route], [titleRect], [target]);
    expect(route.points).toEqual(points);
  });
});

describe('applyLabelOffset', () => {
  const route = vertical(100, 0, 300);
  const label = { x: 60, y: 140, width: 80, height: 20 };

  it('applies an offset that keeps the label clear and near its line', () => {
    expect(applyLabelOffset(label, { x: 10, y: -20 }, route, [], [])).toEqual({
      ...label,
      x: 70,
      y: 120,
    });
  });

  it('ignores an offset that would put the label on a box', () => {
    const box = { x: 150, y: 100, width: 100, height: 100 };
    expect(applyLabelOffset(label, { x: 60, y: 0 }, route, [], [box])).toEqual(label);
  });

  it('ignores an offset that would take the label far from its line', () => {
    expect(applyLabelOffset(label, { x: 200, y: 0 }, route, [], [])).toEqual(label);
  });

  it('ignores an offset that would put the label over a bend in its own line', () => {
    const bent = [
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ];
    // On the vertical run, well above the corner: a small offset keeps it there, a large one
    // would drop it onto the corner.
    const onRun = { x: 60, y: 30, width: 80, height: 20 };
    expect(applyLabelOffset(onRun, { x: 0, y: 60 }, bent, [], [])).toEqual(onRun);
    expect(applyLabelOffset(onRun, { x: 0, y: 10 }, bent, [], [])).toEqual({ ...onRun, y: 40 });
  });

  it('ignores an offset that would put the label across another line', () => {
    expect(
      applyLabelOffset(
        label,
        { x: 0, y: -60 },
        route,
        [
          [
            { x: 0, y: 90 },
            { x: 300, y: 90 },
          ],
        ],
        []
      )
    ).toEqual(label);
  });
});

describe('labelOnBend', () => {
  const bent = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 200, y: 100 },
  ];

  it('spots a label over a corner of the route, or close to one', () => {
    expect(labelOnBend({ x: -20, y: 90, width: 40, height: 20 }, bent)).toBe(true);
    expect(labelOnBend({ x: -20, y: 76, width: 40, height: 20 }, bent)).toBe(true);
  });

  it('ignores the ends of the route and labels on a straight run', () => {
    expect(labelOnBend({ x: -20, y: 40, width: 40, height: 20 }, bent)).toBe(false);
    expect(labelOnBend({ x: -20, y: -10, width: 40, height: 20 }, bent)).toBe(false);
    expect(labelOnBend({ x: 180, y: 90, width: 40, height: 20 }, bent)).toBe(false);
  });
});
