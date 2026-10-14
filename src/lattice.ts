/**
 * Crystallographic helpers — a faithful TypeScript port of the reference
 * engine's lattice module (same conventions, same ordering), so that every
 * derived quantity (plane normals, interplanar spacings, equivalent planes,
 * nearest-neighbour distance) is bit-for-bit comparable with the Python engine.
 */

import type { HKL } from './types'

/** The 48 signed permutation matrices = cubic point group m-3m (order 48). */
export function cubicSymmetryOps(): number[][][] {
  const ops: number[][][] = []
  const perms: Array<[number, number, number]> = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]
  for (const p of perms) {
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const m = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ]
          m[0][p[0]] = sx
          m[1][p[1]] = sy
          m[2][p[2]] = sz
          ops.push(m)
        }
      }
    }
  }
  return ops
}

const OPS = cubicSymmetryOps()

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return x || 1
}

/** Reduce a Miller triple by its greatest common divisor (sign is preserved). */
export function reduceHkl(hkl: readonly number[]): HKL {
  const h = Math.round(hkl[0])
  const k = Math.round(hkl[1])
  const l = Math.round(hkl[2])
  let g = gcd(gcd(h, k), l)
  if (g === 0) g = 1
  return [h / g, k / g, l / g]
}

/** |hkl| — the norm used for spacings and normals. */
export function millerNorm(hkl: readonly number[]): number {
  return Math.hypot(hkl[0], hkl[1], hkl[2])
}

/** Digit-string family key, e.g. [1,1,0] -> "110" (identical to the engine). */
export function familyKey(hkl: readonly number[]): string {
  const r = reduceHkl(hkl)
  return `${Math.abs(r[0])}${Math.abs(r[1])}${Math.abs(r[2])}`
}

/** Parse a family key back to a canonical (non-negative) Miller triple. */
export function parseFamilyKey(key: string): HKL {
  const digits = key.replace(/[^0-9]/g, '')
  if (!/^\d{1,3}$/.test(digits) || digits.replace(/0/g, '') === '') {
    throw new Error(`Invalid Miller family key '${key}'`)
  }
  return [Number(digits[0]), Number(digits[1]), Number(digits[2])]
}

/** Unit normal of a plane. */
export function unitNormal(hkl: readonly number[]): [number, number, number] {
  const n = millerNorm(hkl)
  return [hkl[0] / n, hkl[1] / n, hkl[2] / n]
}

/** d_hkl = a / |hkl| for a cubic lattice. */
export function interplanarSpacing(a: number, hkl: readonly number[]): number {
  return a / millerNorm(hkl)
}

/** FCC nearest-neighbour distance = a / sqrt(2) (12 neighbours). */
export function nearestNeighbourDistance(a: number): number {
  return a / Math.SQRT2
}

/**
 * All distinct planes equivalent to (hkl) under the 48 cubic operations,
 * sorted lexicographically — exactly like the reference engine, so plane
 * indices (and therefore facet indices) line up.
 * {100} -> 6 planes, {110} -> 12 planes, {111} -> 8 planes.
 */
export function equivalentPlanes(hkl: readonly number[]): HKL[] {
  const seen = new Map<string, HKL>()
  for (const op of OPS) {
    const v = reduceHkl([
      op[0][0] * hkl[0] + op[0][1] * hkl[1] + op[0][2] * hkl[2],
      op[1][0] * hkl[0] + op[1][1] * hkl[1] + op[1][2] * hkl[2],
      op[2][0] * hkl[0] + op[2][1] * hkl[1] + op[2][2] * hkl[2],
    ])
    seen.set(`${v[0]},${v[1]},${v[2]}`, v)
  }
  return [...seen.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
}
