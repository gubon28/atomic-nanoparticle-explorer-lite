/**
 * Element metadata for the FCC metals supported by the Lite explorer.
 *
 * Lattice constants are room-temperature experimental values for the
 * conventional cubic cell (Angstrom), taken from standard crystallographic
 * tables (CRC Handbook of Chemistry and Physics; Wyckoff / Pearson).
 *
 * All five metals crystallise in the face-centred cubic structure
 * (space group Fm-3m, No. 225, Pearson symbol cF4) with 4 atoms per cubic cell.
 * These values are identical to the reference engine used to freeze the
 * validation fixtures, so the local browser calculation reproduces it exactly.
 */

import type { ElementInfo, ElementSymbol } from './types'

const FCC = {
  latticeType: 'fcc',
  atomsPerUnitCell: 4,
} as const

/** pi / (3*sqrt(2)) — fraction of the cubic cell filled by the atoms */
export const FCC_PACKING_FRACTION = Math.PI / (3 * Math.SQRT2)

const RAW: Record<
  ElementSymbol,
  {
    name: string
    atomicNumber: number
    a: number
    mass: number
    metallicRadius: number
    density: number
    color: string
  }
> = {
  Au: { name: 'Gold', atomicNumber: 79, a: 4.0782, mass: 196.966569, metallicRadius: 1.442, density: 19.3, color: '#F7C948' },
  Ag: { name: 'Silver', atomicNumber: 47, a: 4.0853, mass: 107.8682, metallicRadius: 1.445, density: 10.49, color: '#C7CEDB' },
  Pt: { name: 'Platinum', atomicNumber: 78, a: 3.9242, mass: 195.084, metallicRadius: 1.387, density: 21.45, color: '#DCE3EC' },
  Pd: { name: 'Palladium', atomicNumber: 46, a: 3.8907, mass: 106.42, metallicRadius: 1.376, density: 12.02, color: '#AEB9C6' },
  Cu: { name: 'Copper', atomicNumber: 29, a: 3.6149, mass: 63.546, metallicRadius: 1.278, density: 8.96, color: '#C87137' },
}

export const ELEMENT_SYMBOLS = Object.keys(RAW) as ElementSymbol[]

export function elementInfo(symbol: ElementSymbol): ElementInfo {
  const raw = RAW[symbol]
  if (!raw) throw new Error(`Unsupported element '${symbol}'`)
  const a = raw.a
  return {
    symbol,
    name: raw.name,
    atomicNumber: raw.atomicNumber,
    latticeConstantA: a,
    atomicMass: raw.mass,
    metallicRadiusA: raw.metallicRadius,
    densityGCm3: raw.density,
    color: raw.color,
    nearestNeighbourA: a / Math.SQRT2,
    surfaceDensity100: 2 / (a * a),
    surfaceDensity111: 4 / (Math.sqrt(3) * a * a),
    surfaceDensity110: (2 * Math.SQRT2) / (a * a),
  }
}

export const FCC_INFO = FCC
