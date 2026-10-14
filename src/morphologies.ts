/**
 * The morphology presets of the Lite edition (basic Wulff-type shapes built by
 * intersecting crystallographic half-spaces).
 *
 * The weights are relative plane distances d_hkl (dimensionless).  They are the
 * same numbers the reference engine uses, so the resulting polyhedra — and the
 * clipped atom sets — are identical.
 *
 * Deliberately NOT included in the Lite edition (advanced features):
 * high-index facets such as {210}/{211}/{310}/{321} or user-defined (hkl),
 * concave pits, nanorods/nanoplates/bipyramids, multiply twinned clusters.
 */

import type { MorphologyId, MorphologyInfo } from './types'

const SQRT3_OVER_2 = Math.sqrt(3) / 2 // 0.8660254...
const TWO_OVER_SQRT3 = 2 / Math.sqrt(3) // 1.1547005...

export const MORPHOLOGIES: MorphologyInfo[] = [
  {
    id: 'cube',
    label: 'Cube',
    facetLabel: '{100}',
    description: 'Six {100} square facets — the intersection of the 6 half-spaces |x|, |y|, |z| <= d.',
    weights: { '100': 1 },
  },
  {
    id: 'octahedron',
    label: 'Octahedron',
    facetLabel: '{111}',
    description: 'Eight {111} triangular facets — the Wulff shape when gamma{111} << gamma{100}.',
    weights: { '111': 1 },
  },
  {
    id: 'rhombic_dodecahedron',
    label: 'Rhombic dodecahedron',
    facetLabel: '{110}',
    description: 'Twelve {110} rhombic facets (70.53 deg / 109.47 deg) — the Voronoi cell of the FCC lattice.',
    weights: { '110': 1 },
  },
  {
    id: 'truncated_octahedron',
    label: 'Truncated octahedron',
    facetLabel: '{100}+{111}',
    description: 'Six squares + eight hexagons — the equilibrium FCC shape near gamma{100}/gamma{111} = 1.155.',
    weights: { '100': 1, '111': SQRT3_OVER_2 },
  },
  {
    id: 'cuboctahedron',
    label: 'Cuboctahedron',
    facetLabel: '{100}+{111}',
    description: 'Six squares + eight triangles (equal facet plane distances for {100} and {111}).',
    weights: { '100': 1, '111': TWO_OVER_SQRT3 },
  },
  {
    id: 'custom',
    label: 'Custom {100}/{110}/{111}',
    facetLabel: 'custom',
    description:
      'Free mix of the three low-index families. Slider = relative plane distance (the "knife" distance): bigger grows that face, smaller shrinks or removes it.',
    weights: { '100': 1, '110': 1, '111': 1 },
  },
]

export const MORPHOLOGY_BY_ID: Record<MorphologyId, MorphologyInfo> = MORPHOLOGIES.reduce(
  (acc, m) => {
    acc[m.id] = m
    return acc
  },
  {} as Record<MorphologyId, MorphologyInfo>,
)

/**
 * Resolve the request into relative plane-distance weights.
 * Families are returned in ascending key order so the plane list (and every
 * facet index derived from it) is deterministic and matches the reference engine.
 */
export function resolveWeights(
  morphology: MorphologyId,
  custom: Record<string, number> | null | undefined,
): Record<string, number> {
  const source = morphology === 'custom' ? custom : MORPHOLOGY_BY_ID[morphology]?.weights
  if (!source) throw new Error(`Unknown morphology '${morphology}'`)

  const entries: Array<[string, number]> = []
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue
    const w = Number(value)
    if (!Number.isFinite(w) || w <= 0) continue
    entries.push([key.replace(/[^0-9]/g, ''), w])
  }
  if (entries.length === 0) throw new Error('Custom morphology needs at least one positive plane distance.')
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  const weights: Record<string, number> = {}
  for (const [key, w] of entries) weights[key] = w
  return weights
}

/** Families offered by the Lite custom slider panel. */
export const CUSTOM_FAMILIES: Array<{ key: string; label: string }> = [
  { key: '100', label: '{100}' },
  { key: '110', label: '{110}' },
  { key: '111', label: '{111}' },
]
