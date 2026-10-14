/**
 * Safeguards against browser freezes / excessive computation.
 *
 * The Lite edition runs the whole calculation on the main thread of the user's
 * browser, so every request is checked BEFORE the heavy work starts:
 *
 *   1. `estimateAtomCount` uses the exact polyhedron volume of the requested
 *      particle (V / a^3 * 4 atoms per cell) — available before any lattice
 *      enumeration — to predict the atom count.
 *   2. Requests above MAX_ATOMS are refused with a helpful message instead of
 *      freezing the tab.
 *   3. The raw FCC candidate enumeration is capped as well, so a pathological
 *      request cannot allocate an enormous array.
 */

import type { ElementInfo, ShapeResult } from './types'

/** Hard cap on the number of atoms a Lite request may produce. */
export const MAX_ATOMS = 30_000
/** Hard cap on the number of candidate lattice sites enumerated. */
export const MAX_CANDIDATES = 2_000_000
/** Largest particle diameter accepted by the UI (nm). */
export const MAX_DIAMETER_NM = 20

export class LimitExceededError extends Error {
  readonly estimate: number
  readonly limit: number
  constructor(message: string, estimate: number, limit: number) {
    super(message)
    this.name = 'LimitExceededError'
    this.estimate = estimate
    this.limit = limit
  }
}

/** Atoms per Angstrom^3 for an FCC lattice of constant a (4 atoms / a^3). */
export function atomDensity(a: number): number {
  return 4 / (a * a * a)
}

/**
 * Predict the atom count from the exact ideal volume of the shape.
 * Accurate to ~2 % for the sizes used here (the error is the discrete surface
 * layer, which the estimate deliberately does not model).
 */
export function estimateAtomCount(shape: ShapeResult, element: ElementInfo): number {
  return Math.round(shape.volumeA3 * atomDensity(element.latticeConstantA))
}

export function assertWithinLimits(
  shape: ShapeResult,
  element: ElementInfo,
  requestedDiameterNm: number,
): number {
  if (requestedDiameterNm > MAX_DIAMETER_NM) {
    throw new LimitExceededError(
      `Diameter ${requestedDiameterNm.toFixed(1)} nm exceeds the Lite limit of ${MAX_DIAMETER_NM} nm.`,
      requestedDiameterNm,
      MAX_DIAMETER_NM,
    )
  }
  const estimate = estimateAtomCount(shape, element)
  if (estimate > MAX_ATOMS) {
    throw new LimitExceededError(
      `This request would build about ${estimate.toLocaleString()} atoms, above the Lite limit of ` +
        `${MAX_ATOMS.toLocaleString()} (browser memory / frame-time guard). Reduce the diameter, or use the ` +
        `full desktop edition for very large particles.`,
      estimate,
      MAX_ATOMS,
    )
  }
  return estimate
}
