/**
 * Top-level orchestration: request -> planes -> polyhedron -> clipped atoms ->
 * analysis.  Everything happens locally; there is no server or external API.
 */

import { analyse } from './analysis'
import { elementInfo } from './elements'
import { assertWithinLimits, MAX_CANDIDATES } from './limits'
import { MORPHOLOGY_BY_ID, resolveWeights } from './morphologies'
import {
  buildPlanes,
  buildShape,
  enumerateFccSites,
  planeDistances,
  positionsInShape,
  sortPositions,
} from './shapeBuilder'
import type { ElementInfo, LiteRequest, LiteResult, MorphologyInfo } from './types'

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export interface BuildOptions {
  /** skip the atom budget check (used by the test-suite for tiny shapes only) */
  ignoreLimits?: boolean
}

/**
 * Build one nanoparticle entirely in the browser.
 *
 * Determinism: the lattice origin (0,0,0) is a lattice site, so the particle is
 * centred on an atom and no random shifting happens — the same request always
 * yields the same coordinates, and the coordinates equal the reference engine's
 * for the same input.
 */
export function buildNanoparticle(request: LiteRequest, options: BuildOptions = {}): LiteResult {
  const t0 = nowMs()
  const warnings: string[] = []

  const element: ElementInfo = elementInfo(request.element)
  const a = element.latticeConstantA
  const morphology: MorphologyInfo = MORPHOLOGY_BY_ID[request.morphology]
  if (!morphology) throw new Error(`Unknown morphology '${request.morphology}'`)

  const weights = resolveWeights(request.morphology, request.customWeights ?? null)

  // 1. probe the shape with the raw relative weights to find the scale that makes
  //    the *ideal* body's largest extent equal to the requested diameter
  const probeDistances: Record<string, number> = {}
  for (const family of Object.keys(weights)) probeDistances[family] = weights[family]
  const probe = buildShape(buildPlanes(a, weights, probeDistances))
  const scale = (request.diameterNm * 10) / probe.maxExtentA

  // 2. absolute plane distances (optionally lattice-aligned) + final polyhedron
  const { distances, snapped } = planeDistances(a, weights, scale, request.latticeAlign)
  const planes = buildPlanes(a, weights, distances)
  const shape = buildShape(planes)
  if (snapped) {
    warnings.push(
      'The global plane scale was snapped so the dominant facet family sits exactly on a lattice plane; ' +
        'all facet distances scale together, so the facet ratios are preserved.',
    )
  }

  // 3. atom budget guard (cheap, before any enumeration)
  const estimate = options.ignoreLimits
    ? 0
    : assertWithinLimits(shape, element, request.diameterNm)
  if (!options.ignoreLimits) {
    const nCell = Math.ceil((Math.max(...planes.map((p) => p.distanceA + 0.5 * p.spacingA)) + a) / a) + 2
    const candidates = (2 * nCell + 1) ** 3 * 4
    if (candidates > MAX_CANDIDATES) {
      throw new Error(
        `This request would enumerate ${candidates.toLocaleString()} candidate lattice sites, above the ` +
          `Lite limit of ${MAX_CANDIDATES.toLocaleString()}. Reduce the diameter.`,
      )
    }
  }

  // 4. FCC lattice + half-space clipping + deterministic ordering
  const reach = Math.max(...planes.map((p) => p.distanceA + (request.boundaryInclusion === 'shell' ? 0.5 * p.spacingA : 0))) + a
  const candidates = enumerateFccSites(a, reach)
  const clipped = positionsInShape(planes, candidates, request.boundaryInclusion)
  const positionsA = sortPositions(clipped)
  if (positionsA.length === 0) {
    throw new Error('No atoms survived the clipping. Increase the diameter.')
  }

  // 5. analysis (the layer tolerance follows the inclusion rule)
  const layerTols = planes.map((p) => (request.boundaryInclusion === 'shell' ? 0.5 * p.spacingA : 0))
  const analysis = analyse(
    positionsA,
    planes,
    shape.facets.map((f) => f.planeIndex),
    a,
    layerTols,
  )

  const achievedNm = shape.maxExtentA / 10
  if (Math.abs(achievedNm - request.diameterNm) > 0.02) {
    warnings.push(
      `Requested diameter ${request.diameterNm.toFixed(2)} nm, achieved ${achievedNm.toFixed(2)} nm ` +
        `(difference ${Math.abs(achievedNm - request.diameterNm).toFixed(3)} nm).`,
    )
  }
  if (!options.ignoreLimits && estimate > 0 && analysis.nAtoms > estimate * 1.15) {
    warnings.push(
      `Atom budget estimate was ${estimate.toLocaleString()}, actual ${analysis.nAtoms.toLocaleString()} ` +
        '(the estimate ignores the discrete surface layer).',
    )
  }

  return {
    request,
    element,
    morphology,
    weights,
    planes,
    shape,
    positionsA,
    analysis,
    cutoffA: 1.2 * element.nearestNeighbourA,
    computeMs: nowMs() - t0,
    warnings,
  }
}

/** Surface area per unit mass (m^2/g) — the usual specific-surface-area figure. */
export function specificSurfaceAreaM2PerG(result: LiteResult): number {
  const atoms = result.analysis.nAtoms
  const massG = (atoms * result.element.atomicMass) / 6.02214076e23
  const areaNm2 = result.shape.surfaceAreaA2 / 100
  return areaNm2 / 1e18 / massG
}
