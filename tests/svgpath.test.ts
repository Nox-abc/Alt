import { describe, expect, it } from 'vitest';
import { cmdsBounds, cmdsToSubPaths, cmdsToSvgD, parseSvgPath, subPathsToCmds, transformCmds, type PathCmd } from '../src/core/path';
import { ellipseCmds, roundRectCmds, starCmds } from '../src/core/shapes';
import { translate } from '../src/core/geometry';

/** Round every coordinate so comparisons are stable. */
function rounded(cmds: PathCmd[], p = 3): PathCmd[] {
  const r = (v: number) => Math.round(v * 10 ** p) / 10 ** p + 0;
  return cmds.map((k) => {
    if (k.c === 'Z') return k;
    if (k.c === 'C') return { c: 'C', x1: r(k.x1), y1: r(k.y1), x2: r(k.x2), y2: r(k.y2), x: r(k.x), y: r(k.y) };
    return { c: k.c, x: r(k.x), y: r(k.y) };
  });
}

describe('parseSvgPath', () => {
  it('converts relative commands, H / V and Z to absolute M / L / Z', () => {
    expect(parseSvgPath('m10 10 l5 0 h5 v5 z')).toEqual([
      { c: 'M', x: 10, y: 10 },
      { c: 'L', x: 15, y: 10 },
      { c: 'L', x: 20, y: 10 },
      { c: 'L', x: 20, y: 15 },
      { c: 'Z' },
    ]);
    expect(parseSvgPath('M0 0 H10 V20 H0 Z')).toEqual([{ c: 'M', x: 0, y: 0 }, { c: 'L', x: 10, y: 0 }, { c: 'L', x: 10, y: 20 }, { c: 'L', x: 0, y: 20 }, { c: 'Z' }]);
  });

  it('treats extra moveto pairs as implicit lineto (absolute and relative)', () => {
    expect(parseSvgPath('M0 0 10 10 20 0')).toEqual([{ c: 'M', x: 0, y: 0 }, { c: 'L', x: 10, y: 10 }, { c: 'L', x: 20, y: 0 }]);
    expect(parseSvgPath('m1 1 2 2')).toEqual([{ c: 'M', x: 1, y: 1 }, { c: 'L', x: 3, y: 3 }]);
  });

  it('starts relative subpaths after Z from the subpath start', () => {
    const cmds = parseSvgPath('M10 10 l10 0 l0 10 z m5 5 l1 1');
    expect(cmds[4]).toEqual({ c: 'M', x: 15, y: 15 });
    expect(cmds[5]).toEqual({ c: 'L', x: 16, y: 16 });
  });

  it('parses compact number syntax (no separators, exponents, leading dots)', () => {
    expect(parseSvgPath('M.5.5L1e1-2')).toEqual([{ c: 'M', x: 0.5, y: 0.5 }, { c: 'L', x: 10, y: -2 }]);
    expect(parseSvgPath('M-1-2l-3-4')).toEqual([{ c: 'M', x: -1, y: -2 }, { c: 'L', x: -4, y: -6 }]);
  });

  it('reflects the previous control point for S / s', () => {
    const abs = parseSvgPath('M0 0 C0 10 10 10 10 0 S20 -10 20 0');
    expect(abs[2]).toEqual({ c: 'C', x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
    const rel = parseSvgPath('M0 0 c0 10 10 10 10 0 s10 -10 10 0');
    expect(rel).toEqual(abs);
    // S without a preceding curve uses the current point as first control
    expect(parseSvgPath('M5 5 S10 10 15 5')[1]).toEqual({ c: 'C', x1: 5, y1: 5, x2: 10, y2: 10, x: 15, y: 5 });
  });

  it('converts quadratics to cubics and reflects T controls', () => {
    const cmds = rounded(parseSvgPath('M0 0 Q5 10 10 0 T20 0'));
    expect(cmds[1]).toEqual({ c: 'C', x1: 3.333, y1: 6.667, x2: 6.667, y2: 6.667, x: 10, y: 0 });
    // reflected control (15, -10)
    expect(cmds[2]).toEqual({ c: 'C', x1: 13.333, y1: -6.667, x2: 16.667, y2: -6.667, x: 20, y: 0 });
    expect(rounded(parseSvgPath('M0 0 q5 10 10 0 t10 0'))).toEqual(cmds);
  });

  it('converts arcs to cubics that end exactly on the target', () => {
    const cmds = parseSvgPath('M0 0 A10 10 0 0 1 20 0');
    expect(cmds.every((k, i) => i === 0 || k.c === 'C')).toBe(true);
    const last = cmds[cmds.length - 1] as Extract<PathCmd, { c: 'C' }>;
    expect(last.x).toBeCloseTo(20, 6);
    expect(last.y).toBeCloseTo(0, 6);
    // sweep = 1 goes clockwise (through y = -10 in SVG's y-down space)
    const b = cmdsBounds(cmds)!;
    expect(b.y).toBeCloseTo(-10, 2);
    expect(b.height).toBeCloseTo(10, 2);
    expect(b.width).toBeCloseTo(20, 2);
  });

  it('handles large-arc and glued arc flags', () => {
    const spaced = parseSvgPath('M0 0 a10 10 0 1 0 20 0');
    const glued = parseSvgPath('M0 0a10 10 0 1020 0');
    expect(rounded(glued)).toEqual(rounded(spaced));
    // large arc, counter-clockwise: the bulge is below the chord
    const b = cmdsBounds(spaced)!;
    expect(b.y + b.height).toBeCloseTo(10, 2);
  });

  it('degenerates zero-radius arcs to lines', () => {
    expect(parseSvgPath('M0 0 A0 5 0 0 1 10 10')).toEqual([{ c: 'M', x: 0, y: 0 }, { c: 'L', x: 10, y: 10 }]);
  });

  it('round-trips through cmdsToSvgD', () => {
    const d = 'M0 0 L10 0 C10 5 5 10 0 10 Z';
    expect(cmdsToSvgD(parseSvgPath(d))).toBe(d);
  });
});

describe('sub-path model', () => {
  it('round-trips open paths with lines and curves', () => {
    const cmds = parseSvgPath('M0 0 L10 0 C15 0 20 5 20 10 L20 20');
    const sp = cmdsToSubPaths(cmds);
    expect(sp).toHaveLength(1);
    expect(sp[0].closed).toBe(false);
    expect(sp[0].points).toHaveLength(4);
    expect(subPathsToCmds(sp)).toEqual(cmds);
  });

  it('merges the duplicated closing point of closed curves', () => {
    const cmds = roundRectCmds(100, 60, [12, 12, 12, 12]);
    const sp = cmdsToSubPaths(cmds);
    expect(sp[0].closed).toBe(true);
    // 8 corners points, no duplicated start point
    expect(sp[0].points).toHaveLength(8);
    expect(cmdsToSvgD(subPathsToCmds(sp))).toBe(cmdsToSvgD(cmds));
  });

  it('keeps several sub-paths (donut) apart', () => {
    const cmds = ellipseCmds(100, 100, 0, 360, 0.5);
    const sp = cmdsToSubPaths(cmds);
    expect(sp).toHaveLength(2);
    expect(sp.every((p) => p.closed)).toBe(true);
    expect(rounded(subPathsToCmds(sp))).toEqual(rounded(cmds.filter((k, i, a) => !(k.c === 'L' && i > 0 && a[i - 1].c === 'Z'))));
  });

  it('infers handle modes', () => {
    const sp = cmdsToSubPaths(parseSvgPath('M0 0 C0 0 5 -5 10 0 C15 5 20 0 20 0'));
    expect(sp[0].points[1].mode).toBe('mirrored');
    expect(sp[0].points[0].mode).toBe('corner');
  });

  it('round-trips polygon geometry and transforms', () => {
    const cmds = starCmds({ width: 50, height: 50, points: 5, innerRadius: 0.4, cornerRadius: 0 });
    const moved = transformCmds(cmds, translate(10, 20));
    const b0 = cmdsBounds(cmds)!;
    const b1 = cmdsBounds(moved)!;
    expect(b1.x - b0.x).toBeCloseTo(10);
    expect(b1.y - b0.y).toBeCloseTo(20);
    expect(rounded(subPathsToCmds(cmdsToSubPaths(moved)))).toEqual(rounded(moved));
  });
});
