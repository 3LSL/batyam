import { describe, expect, it } from 'vitest';
import {
  cylinderGeometry,
  insideOutline,
  personGeometry,
  pointAlongRoute,
  routeCrossesRect,
  routeLength,
  segmentCrossesRect,
  simplifyRoute,
  snapToOutline,
} from './c4Geometry.js';

const box = { x: 0, y: 0, width: 200, height: 120 };

describe('insideOutline', () => {
  it('leaves out the corners of a rounded box', () => {
    const outline = { kind: 'rounded' as const, rect: box, radius: 12 };
    expect(insideOutline(outline, { x: 100, y: 60 })).toBe(true);
    expect(insideOutline(outline, { x: 1, y: 1 })).toBe(false);
    expect(insideOutline(outline, { x: 12, y: 1 })).toBe(true);
  });

  it('follows the head and body of a person', () => {
    const outline = { kind: 'person' as const, rect: box };
    const { head, body } = personGeometry(box);
    expect(insideOutline(outline, { x: head.cx, y: head.cy })).toBe(true);
    // Beside the head, above the shoulders, is outside.
    expect(insideOutline(outline, { x: 5, y: head.cy })).toBe(false);
    expect(insideOutline(outline, { x: 100, y: body.y + body.height / 2 })).toBe(true);
  });

  it('follows the curved ends of a database', () => {
    const outline = { kind: 'cylinder' as const, rect: box };
    const { ry } = cylinderGeometry(box);
    expect(insideOutline(outline, { x: 100, y: 1 })).toBe(true);
    expect(insideOutline(outline, { x: 3, y: 1 })).toBe(false);
    expect(insideOutline(outline, { x: 3, y: ry + 5 })).toBe(true);
  });
});

describe('snapToOutline', () => {
  it('moves an end above the shoulder of a person down to the body', () => {
    const outline = { kind: 'person' as const, rect: box };
    const { body } = personGeometry(box);
    const end = snapToOutline(outline, { x: 20, y: -50 }, { x: 20, y: 0 });
    expect(end.x).toBe(20);
    expect(end.y).toBeGreaterThan(0);
    expect(end.y).toBeLessThanOrEqual(body.y + 1);
  });

  it('moves an end above the curve of a database onto the curve', () => {
    const outline = { kind: 'cylinder' as const, rect: box };
    const end = snapToOutline(outline, { x: 10, y: -40 }, { x: 10, y: 0 });
    expect(end.x).toBe(10);
    expect(end.y).toBeGreaterThan(0);
    expect(insideOutline(outline, { x: end.x, y: end.y + 0.5 })).toBe(true);
  });

  it('keeps an end that is already on the outline', () => {
    const outline = { kind: 'rect' as const, rect: box };
    expect(snapToOutline(outline, { x: 100, y: -40 }, { x: 100, y: 0 })).toEqual({
      x: 100,
      y: 0,
    });
  });

  it('runs along the axis of the last segment, not a sliver off it', () => {
    const outline = { kind: 'person' as const, rect: box };
    const end = snapToOutline(outline, { x: 20.3, y: -50 }, { x: 20, y: 0 });
    expect(end.x).toBe(20.3);
  });

  it('reaches across the empty corner of the box to the head', () => {
    const outline = { kind: 'person' as const, rect: box };
    const { head } = personGeometry(box);
    const end = snapToOutline(outline, { x: -40, y: 2 }, { x: 0, y: 2 });
    expect(end.y).toBe(2);
    expect(end.x).toBeGreaterThan(0);
    expect(end.x).toBeLessThan(head.cx);
  });

  it('keeps an end whose route would miss the shape', () => {
    const outline = { kind: 'person' as const, rect: box };
    // Heading out of the box rather than into it.
    const end = snapToOutline(outline, { x: 10, y: 50 }, { x: 10, y: 0 });
    expect(end).toEqual({ x: 10, y: 0 });
  });
});

describe('segments and routes', () => {
  it('tells crossing a box from touching it', () => {
    expect(segmentCrossesRect({ x: -10, y: 60 }, { x: 210, y: 60 }, box)).toBe(true);
    expect(segmentCrossesRect({ x: -10, y: 0 }, { x: 210, y: 0 }, box)).toBe(false);
    expect(segmentCrossesRect({ x: -10, y: -1 }, { x: 210, y: -1 }, box)).toBe(false);
    expect(
      routeCrossesRect(
        [
          { x: -50, y: -50 },
          { x: 100, y: -50 },
          { x: 100, y: 50 },
        ],
        box
      )
    ).toBe(true);
  });

  it('measures and walks a route', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 0, y: 30 },
      { x: 40, y: 30 },
    ];
    expect(routeLength(route)).toBe(70);
    expect(pointAlongRoute(route, 50)).toEqual({ x: 20, y: 30 });
  });

  it('drops repeated points and points in the middle of a straight run', () => {
    expect(
      simplifyRoute([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 0, y: 20 },
        { x: 10, y: 20 },
      ])
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 10, y: 20 },
    ]);
  });

  it('keeps a point where a route turns back on itself', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 0, y: 10 },
    ];
    expect(simplifyRoute(route)).toHaveLength(3);
  });
});
