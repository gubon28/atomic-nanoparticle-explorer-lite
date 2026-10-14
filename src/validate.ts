/**
 * In-browser scientific self-checks.
 *
 * Every check is recomputed from the CURRENT structure with an independent
 * formula (closed-form volume for the regular shapes, exact FCC geometry for
 * distances and lattice validity, integer parity for on-lattice checks), so the
 * panel shows whether the local calculation is internally consistent — not just
 * a stored assertion.
 */

import { nearestNeighbourDistance } from './lattice'
import type { LiteResult } from './types'

export interface SelfCheck {
  id: string
  name: string
  passed: boolean
  detail: string
  tolerance: string
}

function minPairDistance(positions: Float64Array, cutoff: number): number {
  const n = positions.length / 3
  let best = Infinity
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = positions[i * 3] - positions[j * 3]
      const dy = positions[i * 3 + 1] - positions[j * 3 + 1]
      const dz = positions[i * 3 + 2] - positions[j * 3 + 2]
      const d = Math.hypot(dx, dy, dz)
      if (d < best) best = d
      if (best <= cutoff * 0.999) return best
    }
  }
  return best
}

/**
 * Analytic volumes of the regular bodies in terms of the facet distance d.
 *
 * Only closed forms that were verified against the reference engine are listed
 * (cube: 8000 A^3 and octahedron: 2604.167 A^3 for the 2.0 / 2.5 nm cases).
 * The rhombic dodecahedron is deliberately NOT listed: its plane-distance
 * relation is not reproduced by the textbook 16/9 R^3 normalisation, so instead
 * of shipping an unchecked formula the test-suite validates it against the
 * frozen reference values (`tests/fixtures/full-engine.json`).
 */
export function analyticVolume(morphology: string, d: number): number | null {
  switch (morphology) {
    case 'cube':
      // |x|,|y|,|z| <= d  ->  V = (2d)^3
      return Math.pow(2 * d, 3)
    case 'octahedron':
      // |x|+|y|+|z| <= d*sqrt(3)  ->  V = 4/3 * (d*sqrt(3))^3 = 4*sqrt(3) d^3
      return 4 * Math.sqrt(3) * Math.pow(d, 3)
    default:
      return null
  }
}

export function runSelfChecks(result: LiteResult): SelfCheck[] {
  const checks: SelfCheck[] = []
  const a = result.element.latticeConstantA
  const dNn = nearestNeighbourDistance(a)
  const n = result.analysis.nAtoms

  // 1. every coordinate lies exactly on the FCC lattice (a/2 grid, even parity)
  let worstLattice = 0
  let onLattice = true
  for (let i = 0; i < n; i += 1) {
    const xi = result.positionsA[i * 3] / a
    const yi = result.positionsA[i * 3 + 1] / a
    const zi = result.positionsA[i * 3 + 2] / a
    const doubled = [xi * 2, yi * 2, zi * 2]
    for (const value of doubled) {
      const dev = Math.abs(value - Math.round(value))
      if (dev > worstLattice) worstLattice = dev
      if (dev > 1e-9) onLattice = false
    }
    const parity = Math.round(xi * 2) + Math.round(yi * 2) + Math.round(zi * 2)
    if (parity % 2 !== 0) onLattice = false
  }
  checks.push({
    id: 'fcc-lattice',
    name: 'All atoms sit exactly on FCC sites (a/2 grid, i+j+k even)',
    passed: onLattice,
    detail: `max deviation from a/2 grid = ${(worstLattice * a).toExponential(2)} A`,
    tolerance: '1e-9 (grid units)',
  })

  // 2. shortest interatomic distance equals the FCC nearest-neighbour distance
  const minD = minPairDistance(result.positionsA, dNn * 1.05)
  const relErr = Math.abs(minD - dNn) / dNn
  checks.push({
    id: 'nn-distance',
    name: `Nearest-neighbour distance = a/sqrt(2) = ${dNn.toFixed(6)} A`,
    passed: relErr < 1e-9,
    detail: `measured ${minD.toFixed(9)} A (relative error ${relErr.toExponential(2)})`,
    tolerance: 'rel. 1e-9',
  })

  // 3. coordination numbers never exceed the FCC maximum of 12
  //    (very small particles may not contain a single 12-coordinated atom, so the
  //    bulk region is reported rather than required)
  checks.push({
    id: 'cn-max',
    name: 'Maximum coordination number = 12 (FCC bulk)',
    passed: result.analysis.maxCn <= 12,
    detail: `max CN = ${result.analysis.maxCn}, atoms with the bulk CN 12 = ${result.analysis.bulkAtoms.toLocaleString()}`,
    tolerance: 'integer <= 12',
  })

  // 4. every facet normal matches its assigned Miller index
  let worstNormal = 0
  for (const facet of result.shape.facets) {
    const dot =
      facet.normal[0] * facet.miller[0] + facet.normal[1] * facet.miller[1] + facet.normal[2] * facet.miller[2]
    const norm = Math.hypot(facet.miller[0], facet.miller[1], facet.miller[2])
    worstNormal = Math.max(worstNormal, Math.abs(1 - dot / norm))
  }
  checks.push({
    id: 'facet-normals',
    name: 'Facet normals match their Miller indices (cos = 1)',
    passed: worstNormal < 1e-12,
    detail: `${result.shape.facets.length} facets, worst |1 - cos| = ${worstNormal.toExponential(2)}`,
    tolerance: '1e-12',
  })

  // 5. exact volume against the closed form (regular shapes only)
  const d = result.planes.length ? result.planes[0].distanceA : 0
  const primary = Object.keys(result.weights).reduce((best, f) => (result.weights[f] > result.weights[best] ? f : best), '100')
  const familyDistance: Record<string, number> = {}
  for (const plane of result.planes) familyDistance[plane.family] = plane.distanceA
  const analytic = analyticVolume(result.morphology.id, familyDistance[primary] ?? d)
  if (analytic !== null && Object.keys(result.weights).length === 1) {
    const err = Math.abs(result.shape.volumeA3 - analytic) / analytic
    checks.push({
      id: 'volume-analytic',
      name: 'Polyhedron volume agrees with the closed-form value',
      passed: err < 1e-9,
      detail: `V = ${result.shape.volumeA3.toFixed(6)} A^3 vs analytic ${analytic.toFixed(6)} A^3 (rel. ${err.toExponential(2)})`,
      tolerance: 'rel. 1e-9',
    })
  } else {
    const edge = result.shape.surfaceAreaA2 > 0 ? 6 * (result.shape.volumeA3 ** (2 / 3)) : 0
    checks.push({
      id: 'volume-surface-consistent',
      name: 'Volume and surface area are positive and mutually consistent',
      passed: result.shape.volumeA3 > 0 && result.shape.surfaceAreaA2 > 0 && result.shape.surfaceAreaA2 < edge,
      detail: `V = ${result.shape.volumeA3.toFixed(3)} A^3, A = ${result.shape.surfaceAreaA2.toFixed(3)} A^2`,
      tolerance: 'A < 6 V^(2/3) (cube bound)',
    })
  }

  // 6. population balance
  const summed =
    result.analysis.classCounts.bulk +
    result.analysis.classCounts.facet +
    result.analysis.classCounts.edge +
    result.analysis.classCounts.corner +
    result.analysis.classCounts.surface_other
  checks.push({
    id: 'population-balance',
    name: 'Every atom is classified exactly once',
    passed: summed === n,
    detail: `classified ${summed.toLocaleString()} of ${n.toLocaleString()} atoms · surface ${result.analysis.surfaceAtoms.toLocaleString()}`,
    tolerance: 'exact',
  })

  return checks
}
