/**
 * Coordination and surface-site analysis — port of the reference engine.
 *
 * Coordination numbers use a plain radial cut-off (no bonding heuristics):
 * two atoms are neighbours when their distance is at most 1.2 * a/sqrt(2),
 * which lies between the first (a/sqrt(2) = 0.707a) and second (a = 1.414 d_nn)
 * FCC shells.
 *
 * Facet/edge/corner assignment is measured against the OUTERMOST OCCUPIED atomic
 * layer of each facet plane, not against the ideal mathematical plane: with
 * continuous (non-aligned) facet distances a plane can fall between two lattice
 * layers, and measuring against the ideal plane would then classify no atom at
 * all as a terrace atom.  The layer offset is symmetric for symmetry-equivalent
 * planes, so the per-facet counts stay equal.
 */

import { nearestNeighbourDistance } from './lattice'
import {
  CLASS_BULK,
  CLASS_CORNER,
  CLASS_EDGE,
  CLASS_FACET,
  CLASS_SURFACE_OTHER,
  type AnalysisResult,
  type Plane,
} from './types'

export const CLASS_LABELS: Record<number, string> = {
  [CLASS_BULK]: 'bulk (12 neighbours)',
  [CLASS_FACET]: 'facet terrace (1 plane)',
  [CLASS_EDGE]: 'facet edge (2 planes)',
  [CLASS_CORNER]: 'vertex / corner (3+ planes)',
  [CLASS_SURFACE_OTHER]: 'other surface (step / kink)',
}

/** Neighbour counting on a uniform grid — O(N) instead of O(N^2).
 *
 * The bucket key must be INJECTIVE: an earlier version used an XOR hash, so two
 * different cells could share a bucket and their atoms were then counted twice
 * (13-15 neighbours instead of 12).  The key below is a plain base-2048 packing
 * of the (bounded) cell coordinates, which cannot collide for the sizes the Lite
 * edition allows.
 */
export function coordinationNumbers(positionsA: Float64Array, cutoffA: number): Int8Array {
  const n = positionsA.length / 3
  const cn = new Int8Array(n)
  if (n < 2) return cn
  const cell = Math.max(cutoffA, 1e-6)
  const inv = 1 / cell
  const buckets = new Map<number, number[]>()
  const key = (ix: number, iy: number, iz: number): number =>
    ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024)
  const coords = new Int32Array(n * 3)
  for (let s = 0; s < n; s += 1) {
    const ix = Math.floor(positionsA[s * 3] * inv)
    const iy = Math.floor(positionsA[s * 3 + 1] * inv)
    const iz = Math.floor(positionsA[s * 3 + 2] * inv)
    coords[s * 3] = ix
    coords[s * 3 + 1] = iy
    coords[s * 3 + 2] = iz
    const k = key(ix, iy, iz)
    const list = buckets.get(k)
    if (list) list.push(s)
    else buckets.set(k, [s])
  }
  const cutoff2 = cutoffA * cutoffA
  for (let s = 0; s < n; s += 1) {
    const ix = coords[s * 3]
    const iy = coords[s * 3 + 1]
    const iz = coords[s * 3 + 2]
    const x = positionsA[s * 3]
    const y = positionsA[s * 3 + 1]
    const z = positionsA[s * 3 + 2]
    let count = 0
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const list = buckets.get(key(ix + dx, iy + dy, iz + dz))
          if (!list) continue
          for (const t of list) {
            if (t === s) continue
            const ex = positionsA[t * 3] - x
            const ey = positionsA[t * 3 + 1] - y
            const ez = positionsA[t * 3 + 2] - z
            if (ex * ex + ey * ey + ez * ez <= cutoff2) count += 1
          }
        }
      }
    }
    cn[s] = count
  }
  return cn
}

/**
 * Site classes + facet attribution (identical rules to the reference engine).
 *
 * `layerTolsA[i]` is the boundary tolerance of plane i (0 for the 'center'
 * inclusion rule, half the interplanar spacing for 'shell'): it decides which
 * atoms still count as the outermost occupied layer of that facet plane, exactly
 * as the reference engine does.
 */
export function analyse(
  positionsA: Float64Array,
  planes: readonly Plane[],
  facetPlaneIndexByFacet: number[],
  a: number,
  layerTolsA: readonly number[] = planes.map(() => 0),
): AnalysisResult {
  const nAtoms = positionsA.length / 3
  const dNn = nearestNeighbourDistance(a)
  const cutoffA = 1.2 * dNn
  const cn = coordinationNumbers(positionsA, cutoffA)

  const nPlanes = planes.length
  const signed = new Float64Array(nAtoms * nPlanes)
  const distanceToSurfaceA = new Float64Array(nAtoms)
  for (let s = 0; s < nAtoms; s += 1) {
    const x = positionsA[s * 3]
    const y = positionsA[s * 3 + 1]
    const z = positionsA[s * 3 + 2]
    let best = Infinity
    for (let i = 0; i < nPlanes; i += 1) {
      const p = planes[i]
      const value = x * p.normal[0] + y * p.normal[1] + z * p.normal[2] - p.distanceA
      signed[s * nPlanes + i] = value
      if (value < best) best = value
    }
    distanceToSurfaceA[s] = best
  }

  // outermost occupied layer per plane (the tolerance of the inclusion rule is
  // what makes 'shell' atoms part of the reference layer)
  const layerOffset = new Float64Array(nPlanes)
  for (let i = 0; i < nPlanes; i += 1) {
    let top = -Infinity
    const limit = (layerTolsA[i] ?? 0) + 1e-9
    for (let s = 0; s < nAtoms; s += 1) {
      const value = signed[s * nPlanes + i]
      if (value <= limit && value > top) top = value
    }
    layerOffset[i] = Number.isFinite(top) ? top : 0
  }

  const tolFacet = 0.35 * dNn
  const nearCount = new Int8Array(nAtoms)
  const firstNearPlane = new Int32Array(nAtoms).fill(-1)
  for (let s = 0; s < nAtoms; s += 1) {
    let count = 0
    let first = -1
    for (let i = 0; i < nPlanes; i += 1) {
      const reference = signed[s * nPlanes + i] - layerOffset[i]
      if (Math.abs(reference) <= tolFacet) {
        count += 1
        if (first < 0) first = i // same as argmax on the boolean mask (first match)
      }
    }
    nearCount[s] = count
    firstNearPlane[s] = first
  }

  const siteClass = new Int8Array(nAtoms)
  const facetPlaneIndex = new Int32Array(nAtoms).fill(-1)
  const facetId = new Int32Array(nAtoms).fill(-1)
  const globalToFacet = new Map<number, number>()
  facetPlaneIndexByFacet.forEach((planeIndex, facetIndex) => globalToFacet.set(planeIndex, facetIndex))

  let surfaceAtoms = 0
  let bulkAtoms = 0
  let maxCn = 0
  const classCounts: Record<string, number> = {
    bulk: 0,
    facet: 0,
    edge: 0,
    corner: 0,
    surface_other: 0,
  }
  for (let s = 0; s < nAtoms; s += 1) {
    const c = cn[s]
    if (c > maxCn) maxCn = c
    if (c >= 12) {
      siteClass[s] = CLASS_BULK
      bulkAtoms += 1
      classCounts.bulk += 1
      continue
    }
    surfaceAtoms += 1
    const nNear = nearCount[s]
    if (nNear === 1) {
      siteClass[s] = CLASS_FACET
      classCounts.facet += 1
      const planeIndex = firstNearPlane[s]
      facetPlaneIndex[s] = planeIndex
      facetId[s] = globalToFacet.get(planeIndex) ?? -1
    } else if (nNear === 2) {
      siteClass[s] = CLASS_EDGE
      classCounts.edge += 1
    } else if (nNear >= 3) {
      siteClass[s] = CLASS_CORNER
      classCounts.corner += 1
    } else {
      siteClass[s] = CLASS_SURFACE_OTHER
      classCounts.surface_other += 1
    }
  }

  const terraceByFamily: Record<string, number> = {}
  for (const plane of planes) {
    terraceByFamily[plane.family] = terraceByFamily[plane.family] ?? 0
  }
  for (let s = 0; s < nAtoms; s += 1) {
    const planeIndex = facetPlaneIndex[s]
    if (planeIndex < 0) continue
    const family = planes[planeIndex].family
    terraceByFamily[family] = (terraceByFamily[family] ?? 0) + 1
  }

  return {
    nAtoms,
    cn,
    siteClass,
    facetPlaneIndex,
    facetId,
    distanceToSurfaceA,
    surfaceAtoms,
    bulkAtoms,
    classCounts,
    terraceByFamily,
    maxCn,
  }
}
