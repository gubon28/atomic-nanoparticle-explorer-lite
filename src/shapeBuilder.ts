/**
 * Half-space geometry: crystallographic planes -> convex polyhedron -> clipped
 * FCC atom set.  Port of the reference engine's shape/generator modules.
 *
 * The polyhedron vertices are obtained WITHOUT any convex-hull library: every
 * vertex of a bounded intersection of half-spaces is the solution of a triple of
 * plane equations, so all C(n,3) triples are solved and those that satisfy every
 * half-space are kept.  For the shapes used here (6..14 planes) that is at most
 * 364 tiny 3x3 systems — instant, exact, and dependency-free.
 */

import { equivalentPlanes, interplanarSpacing, parseFamilyKey, unitNormal } from './lattice'
import type { Plane, ShapeResult, Facet } from './types'

type Vec3 = [number, number, number]

/** The 4-atom FCC basis in fractional coordinates of the conventional cell. */
export const FCC_BASIS: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
  [0.5, 0.5, 0],
]

const TOL_ON_PLANE = 1e-6

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

/** Solve A x = b for a 3x3 system using Cramer's rule (exact in float64). */
function solve3(A: number[][], b: number[], det: number): Vec3 {
  const column = (i: number): number[][] =>
    A.map((row, r) => row.map((value, c) => (c === i ? b[r] : value)))
  return [det3(column(0)) / det, det3(column(1)) / det, det3(column(2)) / det]
}

/** Area of a planar, convex, ordered polygon (Newell's method). */
export function polygonArea(points: readonly Vec3[]): number {
  if (points.length < 3) return 0
  const centre: Vec3 = [0, 0, 0]
  for (const p of points) {
    centre[0] += p[0] / points.length
    centre[1] += p[1] / points.length
    centre[2] += p[2] / points.length
  }
  const acc: Vec3 = [0, 0, 0]
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const rp: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]
    const rq: Vec3 = [q[0] - centre[0], q[1] - centre[1], q[2] - centre[2]]
    acc[0] += rp[1] * rq[2] - rp[2] * rq[1]
    acc[1] += rp[2] * rq[0] - rp[0] * rq[2]
    acc[2] += rp[0] * rq[1] - rp[1] * rq[0]
  }
  return 0.5 * Math.hypot(acc[0], acc[1], acc[2])
}

/** Order coplanar vertices counter-clockwise around the facet normal. */
export function orderPolygon(points: readonly Vec3[], normal: readonly number[]): Vec3[] {
  const centre: Vec3 = [0, 0, 0]
  for (const p of points) {
    centre[0] += p[0] / points.length
    centre[1] += p[1] / points.length
    centre[2] += p[2] / points.length
  }
  const len = Math.hypot(normal[0], normal[1], normal[2])
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len]
  const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u: Vec3 = [n[1] * seed[2] - n[2] * seed[1], n[2] * seed[0] - n[0] * seed[2], n[0] * seed[1] - n[1] * seed[0]]
  const ul = Math.hypot(u[0], u[1], u[2])
  u[0] /= ul
  u[1] /= ul
  u[2] /= ul
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  return [...points]
    .map((p) => {
      const r: Vec3 = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]
      return { p, angle: Math.atan2(dot(r, v), dot(r, u)) }
    })
    .sort((a, b) => a.angle - b.angle)
    .map((entry) => entry.p)
}

export function polygonCentroid(points: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0]
  for (const p of points) {
    c[0] += p[0] / points.length
    c[1] += p[1] / points.length
    c[2] += p[2] / points.length
  }
  return c
}

/** Expand each family into all symmetry-equivalent half-spaces. */
export function buildPlanes(a: number, weights: Record<string, number>, distances: Record<string, number>): Plane[] {
  const planes: Plane[] = []
  for (const family of Object.keys(weights)) {
    if (!(family in distances)) continue
    const hkl = parseFamilyKey(family)
    const spacing = interplanarSpacing(a, hkl)
    for (const planeHkl of equivalentPlanes(hkl)) {
      planes.push({
        index: planes.length,
        miller: planeHkl,
        family,
        normal: unitNormal(planeHkl),
        distanceA: distances[family],
        weight: weights[family],
        spacingA: spacing,
      })
    }
  }
  return planes
}

/**
 * Absolute plane distances (Angstrom).  With latticeAlign a SINGLE global scale
 * factor is snapped so the dominant facet family sits exactly on a lattice plane
 * (an integer multiple of d_hkl) — snapping the global scale keeps the Wulff
 * facet ratios intact.
 */
export function planeDistances(
  a: number,
  weights: Record<string, number>,
  scale: number,
  latticeAlign: boolean,
): { distances: Record<string, number>; snapped: boolean } {
  const families = Object.keys(weights)
  if (!latticeAlign) {
    const distances: Record<string, number> = {}
    for (const f of families) distances[f] = weights[f] * scale
    return { distances, snapped: false }
  }
  const primary = families.reduce((best, f) => (weights[f] > weights[best] ? f : best), families[0])
  const spacing = interplanarSpacing(a, parseFamilyKey(primary))
  const raw = weights[primary] * scale
  const multiple = Math.max(1, Math.round(raw / spacing))
  const adjusted = (multiple * spacing) / weights[primary]
  const distances: Record<string, number> = {}
  for (const f of families) distances[f] = weights[f] * adjusted
  const snapped = Math.abs(distances[primary] - raw) > 1e-9
  return { distances, snapped }
}

/** Intersection of the half-spaces n . r <= d -> vertices + facets + totals. */
export function buildShape(planes: readonly Plane[]): ShapeResult {
  if (planes.length < 4) throw new Error('At least four planes are required to bound a closed body.')
  if (planes.some((p) => p.distanceA <= 0)) {
    throw new Error('All plane distances must be strictly positive (origin inside the body).')
  }

  const n = planes.length
  const keys = new Map<string, Vec3>()
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      for (let k = j + 1; k < n; k += 1) {
        const A = [planes[i].normal as number[], planes[j].normal as number[], planes[k].normal as number[]]
        const det = det3(A)
        if (Math.abs(det) < 1e-9) continue
        const v = solve3(A, [planes[i].distanceA, planes[j].distanceA, planes[k].distanceA], det)
        let feasible = true
        for (let m = 0; m < n; m += 1) {
          if (dot(planes[m].normal, v) > planes[m].distanceA + TOL_ON_PLANE) {
            feasible = false
            break
          }
        }
        if (!feasible) continue
        const key = `${v[0].toFixed(9)},${v[1].toFixed(9)},${v[2].toFixed(9)}`
        if (!keys.has(key)) keys.set(key, v)
      }
    }
  }

  const vertices = [...keys.values()]
  if (vertices.length < 4) throw new Error('The selected planes do not enclose a three-dimensional body.')

  const facets: Facet[] = []
  for (const plane of planes) {
    const onPlane = vertices.filter((v) => Math.abs(dot(plane.normal, v) - plane.distanceA) <= TOL_ON_PLANE)
    if (onPlane.length < 3) continue
    const ordered = orderPolygon(onPlane, plane.normal)
    const area = polygonArea(ordered)
    if (area <= 1e-12) continue
    facets.push({
      index: facets.length,
      planeIndex: plane.index,
      miller: plane.miller,
      family: plane.family,
      normal: plane.normal,
      distanceA: plane.distanceA,
      areaA2: area,
      verticesA: ordered,
    })
  }
  if (facets.length < 4) throw new Error('The selected planes do not bound a closed polyhedron.')

  let surfaceAreaA2 = 0
  let volumeA3 = 0
  for (const f of facets) {
    surfaceAreaA2 += f.areaA2
    volumeA3 += f.areaA2 * f.distanceA
  }
  volumeA3 /= 3 // exact for a convex body containing the origin

  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const v of vertices) {
    for (let c = 0; c < 3; c += 1) {
      if (v[c] < min[c]) min[c] = v[c]
      if (v[c] > max[c]) max[c] = v[c]
    }
  }
  const maxExtentA = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])

  return { facets, surfaceAreaA2, volumeA3, maxExtentA, boundsA: { min, max }, verticesA: vertices }
}

/** Candidate FCC sites of one crystal inside a box of half-width `reachA`. */
export function enumerateFccSites(a: number, reachA: number): Float64Array {
  const nCell = Math.ceil(reachA / a) + 2
  const perAxis = 2 * nCell + 1
  const total = perAxis * perAxis * perAxis * FCC_BASIS.length
  const out = new Float64Array(total * 3)
  let w = 0
  for (let i = -nCell; i <= nCell; i += 1) {
    for (let j = -nCell; j <= nCell; j += 1) {
      for (let k = -nCell; k <= nCell; k += 1) {
        for (const basis of FCC_BASIS) {
          out[w] = (i + basis[0]) * a
          out[w + 1] = (j + basis[1]) * a
          out[w + 2] = (k + basis[2]) * a
          w += 3
        }
      }
    }
  }
  return out.subarray(0, w)
}

/**
 * Half-space clipping with the same deterministic inclusion rule as the engine:
 * 'center' keeps atoms whose centre is inside the body, 'shell' additionally
 * keeps the outermost atomic layer that straddles the surface (tolerance =
 * half the interplanar spacing of that plane).
 */
export function positionsInShape(
  planes: readonly Plane[],
  sitesA: Float64Array,
  boundaryInclusion: 'center' | 'shell' = 'center',
): Float64Array {
  const normals = planes.map((p) => p.normal as number[])
  const distances = planes.map((p) => p.distanceA)
  const tols = planes.map((p) => (boundaryInclusion === 'shell' ? 0.5 * p.spacingA : 0))
  const keep: number[] = []
  const nSites = sitesA.length / 3
  for (let s = 0; s < nSites; s += 1) {
    const x = sitesA[s * 3]
    const y = sitesA[s * 3 + 1]
    const z = sitesA[s * 3 + 2]
    let inside = true
    for (let i = 0; i < planes.length; i += 1) {
      const nrm = normals[i]
      if (x * nrm[0] + y * nrm[1] + z * nrm[2] > distances[i] + tols[i] + 1e-9) {
        inside = false
        break
      }
    }
    if (inside) keep.push(s)
  }
  const out = new Float64Array(keep.length * 3)
  keep.forEach((s, idx) => {
    out[idx * 3] = sitesA[s * 3]
    out[idx * 3 + 1] = sitesA[s * 3 + 1]
    out[idx * 3 + 2] = sitesA[s * 3 + 2]
  })
  return out
}

/** Deterministic ordering (x, then y, then z) — identical to the engine. */
export function sortPositions(positionsA: Float64Array): Float64Array {
  const n = positionsA.length / 3
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((p, q) => {
    const xp = positionsA[p * 3]
    const xq = positionsA[q * 3]
    if (xp !== xq) return xp - xq
    const yp = positionsA[p * 3 + 1]
    const yq = positionsA[q * 3 + 1]
    if (yp !== yq) return yp - yq
    return positionsA[p * 3 + 2] - positionsA[q * 3 + 2]
  })
  const out = new Float64Array(n * 3)
  order.forEach((src, dst) => {
    out[dst * 3] = positionsA[src * 3]
    out[dst * 3 + 1] = positionsA[src * 3 + 1]
    out[dst * 3 + 2] = positionsA[src * 3 + 2]
  })
  return out
}
