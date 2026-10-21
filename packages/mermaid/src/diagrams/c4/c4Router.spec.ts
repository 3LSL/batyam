import { describe, expect, it } from 'vitest';
import type { C4Point, C4Rect } from './c4Layout.js';
import { routeCrossesRect } from './c4Geometry.js';
import { routeOrthogonal, sidePorts } from './c4Router.js';

const isOrthogonal = (route: C4Point[]) =>
  route.every(
    (point, index) =>
      index === 0 ||
      Math.abs(point.x - route[index - 1].x) < 1e-6 ||
      Math.abs(point.y - route[index - 1].y) < 1e-6
  );

describe('routeOrthogonal', () => {
  it('runs straight when nothing is in the way', () => {
    const route = routeOrthogonal({
      start: { point: { x: 0, y: 0 }, heading: 'down' },
      end: { point: { x: 0, y: 200 }, heading: 'down' },
      obstacles: [],
    });
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 200 },
    ]);
  });

  it('goes around an obstacle, keeping clear of it', () => {
    const obstacle: C4Rect = { x: -50, y: 80, width: 100, height: 40 };
    const route = routeOrthogonal({
      start: { point: { x: 0, y: 0 }, heading: 'down' },
      end: { point: { x: 0, y: 200 }, heading: 'down' },
      obstacles: [obstacle],
      clearance: 10,
    })!;
    expect(route).toBeDefined();
    expect(isOrthogonal(route)).toBe(true);
    expect(routeCrossesRect(route, obstacle)).toBe(false);
    expect(route[0]).toEqual({ x: 0, y: 0 });
    expect(route.at(-1)).toEqual({ x: 0, y: 200 });
    // It leaves downwards and arrives downwards.
    expect(route[1].x).toBe(0);
    expect(route.at(-2)!.x).toBe(0);
  });

  it('returns undefined when every way is blocked', () => {
    const route = routeOrthogonal({
      start: { point: { x: 0, y: 0 }, heading: 'down' },
      end: { point: { x: 0, y: 200 }, heading: 'down' },
      // The first step out of the start lands inside an obstacle.
      obstacles: [{ x: -20, y: 5, width: 40, height: 20 }],
      clearance: 5,
    });
    expect(route).toBeUndefined();
  });

  it('picks the cheapest of several candidate ends', () => {
    const target: C4Rect = { x: 300, y: -40, width: 100, height: 80 };
    const route = routeOrthogonal({
      start: { point: { x: 0, y: 0 }, heading: 'right' },
      end: sidePorts(target, true),
      obstacles: [],
    })!;
    // Straight across into the left side of the target.
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ]);
  });

  it('avoids ending where another route already ends', () => {
    const target: C4Rect = { x: 300, y: -60, width: 100, height: 120 };
    const route = routeOrthogonal({
      start: { point: { x: 0, y: 0 }, heading: 'right' },
      end: sidePorts(target, true).filter((port) => port.heading === 'right'),
      obstacles: [],
      occupied: [{ x: 300, y: 0 }],
    })!;
    expect(route.at(-1)!.x).toBe(300);
    expect(route.at(-1)!.y).not.toBe(0);
  });

  it('keeps away from an existing route running alongside', () => {
    const existing = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
    ];
    const route = routeOrthogonal({
      start: { point: { x: 0, y: 20 }, heading: 'up' },
      end: { point: { x: 400, y: 20 }, heading: 'down' },
      obstacles: [],
      avoid: [existing],
      clearance: 12,
    })!;
    // It may cross the existing line, but must not run along it.
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      const horizontal = Math.abs(a.y - b.y) < 1e-6;
      if (horizontal) {
        expect(Math.abs(a.y)).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

describe('sidePorts', () => {
  it('offers ports on all four sides, heading out when leaving and in when arriving', () => {
    const rect: C4Rect = { x: 0, y: 0, width: 200, height: 100 };
    const leaving = sidePorts(rect, false);
    const arriving = sidePorts(rect, true);
    expect(leaving.some((port) => port.point.y === 0 && port.heading === 'up')).toBe(true);
    expect(arriving.some((port) => port.point.y === 0 && port.heading === 'down')).toBe(true);
    expect(leaving.some((port) => port.point.x === 200 && port.heading === 'right')).toBe(true);
    // None closer to a corner than the margin.
    for (const { point } of [...leaving, ...arriving]) {
      const alongTop = point.y === 0 || point.y === 100;
      const along = alongTop ? point.x : point.y;
      const length = alongTop ? 200 : 100;
      expect(along).toBeGreaterThanOrEqual(16);
      expect(length - along).toBeGreaterThanOrEqual(16);
    }
  });
});
