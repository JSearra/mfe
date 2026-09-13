/**
 * Deterministic trigonometry.
 *
 * Math.sin/cos/atan2 are implementation-defined by the ECMAScript spec: they differ
 * across engines and across versions of one engine. Everything here is built from
 * + - * / sqrt and floor, all of which are exactly specified, so results are
 * bit-identical everywhere.
 *
 * A subtlety worth stating, because it is easy to get wrong: the lookup table cannot
 * be built by calling Math.sin at startup. That would make the table itself
 * engine-dependent and quietly reintroduce the divergence this module exists to
 * remove. The table is built from the polynomial kernels below.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const QUARTER_PI = 0.7853981633974483;
const INV_HALF_PI = 0.6366197723675814;
const INV_TWO_PI = 0.15915494309189535;

// --- Polynomial kernels, accurate on |x| <= PI/4 -----------------------------
// Taylor series. Truncation error at the interval edge is about 2e-9 for sin and
// 1e-10 for cos, which is far below what a 32-bit render position can express.

function sinKernel(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 -
      x2 *
        (0.16666666666666666 -
          x2 * (0.008333333333333333 - x2 * (0.0001984126984126984 - x2 * 0.0000027557319223985893))))
  );
}

function cosKernel(x: number): number {
  const x2 = x * x;
  return (
    1 -
    x2 *
      (0.5 -
        x2 * (0.041666666666666664 - x2 * (0.001388888888888889 - x2 * (0.0000248015873015873 - x2 * 2.755731922398589e-7))))
  );
}

/**
 * Exact-as-we-get sin, via quadrant reduction onto the kernels.
 * Use this when precision matters more than speed; sin() below is the hot path.
 */
export function sinExact(x: number): number {
  const n = Math.round(x * INV_HALF_PI);
  const r = x - n * HALF_PI;
  switch (n & 3) {
    case 0:
      return sinKernel(r);
    case 1:
      return cosKernel(r);
    case 2:
      return -sinKernel(r);
    default:
      return -cosKernel(r);
  }
}

export function cosExact(x: number): number {
  return sinExact(x + HALF_PI);
}

// --- Lookup table ------------------------------------------------------------
// 4096 entries over [0, 2*PI), with linear interpolation between them. Maximum
// interpolation error is about 2.9e-7 — a third of a thousandth of a pixel at
// typical sprite scale.

const TABLE_SIZE = 4096;
const TABLE_SCALE = TABLE_SIZE * INV_TWO_PI;

// One extra entry duplicating index 0, so interpolation near the wrap needs no branch.
const SIN_TABLE = new Float64Array(TABLE_SIZE + 1);
for (let i = 0; i < TABLE_SIZE; i++) {
  SIN_TABLE[i] = sinExact((i * TWO_PI) / TABLE_SIZE);
}
SIN_TABLE[TABLE_SIZE] = SIN_TABLE[0]!;

export function sin(x: number): number {
  let pos = x * TABLE_SCALE;
  pos -= Math.floor(pos / TABLE_SIZE) * TABLE_SIZE;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = SIN_TABLE[i]!;
  return a + (SIN_TABLE[i + 1]! - a) * frac;
}

export function cos(x: number): number {
  return sin(x + HALF_PI);
}

// --- atan2 -------------------------------------------------------------------

/**
 * atan for |z| <= 1.
 *
 * The Taylor series for atan converges painfully slowly near z = 1, so the argument
 * is halved twice first using atan(z) = 2*atan(z / (1 + sqrt(1 + z^2))). That pulls
 * |z| <= 1 down to |z| <= 0.199, where a degree-13 series is accurate to about 1e-12.
 */
function atanKernel(z: number): number {
  let h = z / (1 + Math.sqrt(1 + z * z));
  h = h / (1 + Math.sqrt(1 + h * h));

  const h2 = h * h;
  let p = 1 / 13;
  p = -1 / 11 + h2 * p;
  p = 1 / 9 + h2 * p;
  p = -1 / 7 + h2 * p;
  p = 1 / 5 + h2 * p;
  p = -1 / 3 + h2 * p;
  p = 1 + h2 * p;

  return 4 * (h * p);
}

/** Result in (-PI, PI], matching Math.atan2 except that -0 is treated as +0. */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;

  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;

  let a = ay <= ax ? atanKernel(ay / ax) : HALF_PI - atanKernel(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

/** Shortest signed angular difference from `from` to `to`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  d -= Math.floor(d * INV_TWO_PI + 0.5) * TWO_PI;
  return d;
}

/** Interpolate an angle the short way round, so 359deg -> 1deg does not spin. */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + angleDelta(from, to) * t;
}
