/**
 * Colouring + GPU instance data.  The visual sphere radius never changes an
 * atomic coordinate: positions are copied verbatim from the computation.
 */

import { CLASS_BULK, CLASS_CORNER, CLASS_EDGE, CLASS_FACET, CLASS_SURFACE_OTHER, type ColorMode, type LiteResult } from './types'

export const CN_MIN = 0
export const CN_MAX = 12

/** Coordination-number ramp (0 = isolated adatom, 12 = bulk FCC). */
export const CN_RAMP: Record<number, string> = {
  0: '#3B4A5A',
  1: '#3E5C76',
  2: '#3F7E9E',
  3: '#3FA7B5',
  4: '#43C6A8',
  5: '#6ED37F',
  6: '#9BDA66',
  7: '#C4DC58',
  8: '#E8CF52',
  9: '#F5B24C',
  10: '#F08C46',
  11: '#E76B45',
  12: '#D14545',
}

export const SITE_CLASS_COLORS: Record<number, string> = {
  [CLASS_BULK]: '#4A5568',
  [CLASS_FACET]: '#4FC3F7',
  [CLASS_EDGE]: '#FFB74D',
  [CLASS_CORNER]: '#F06292',
  [CLASS_SURFACE_OTHER]: '#B0BEC5',
}

export const FAMILY_COLORS: Record<string, string> = {
  '100': '#4FC3F7',
  '110': '#FFB74D',
  '111': '#81C784',
}

export function coordinationColor(cn: number): string {
  return CN_RAMP[Math.max(CN_MIN, Math.min(CN_MAX, cn))] ?? '#7A8CA0'
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const int = Number.parseInt(full, 16)
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255]
}

export interface RenderData {
  positions: Float32Array
  colors: Float32Array
  /** rendered instance index -> original atom id (for future picking/debug) */
  atomIds: Int32Array
  visibleCount: number
  counts: { total: number; rendered: number; hidden: number }
}

export interface RenderView {
  colorMode: ColorMode
  showBulk: boolean
  showFacetOnly: boolean
}

/** Build the packed instance arrays for the InstancedMesh (one draw call). */
export function buildRenderData(result: LiteResult, view: RenderView): RenderData {
  const { positionsA, analysis, element, planes } = result
  const total = analysis.nAtoms
  const keep: number[] = []
  for (let i = 0; i < total; i += 1) {
    if (!view.showBulk && analysis.siteClass[i] === CLASS_BULK) continue
    if (view.showFacetOnly && analysis.siteClass[i] !== CLASS_FACET) continue
    keep.push(i)
  }

  const positions = new Float32Array(keep.length * 3)
  const colors = new Float32Array(keep.length * 3)
  const colorOf = (i: number): string => {
    switch (view.colorMode) {
      case 'coordination':
        return coordinationColor(analysis.cn[i])
      case 'surface':
        return analysis.siteClass[i] === CLASS_BULK ? '#3C4A5E' : '#FF9F45'
      case 'site_class':
        return SITE_CLASS_COLORS[analysis.siteClass[i]] ?? '#B0BEC5'
      case 'facet': {
        const planeIndex = analysis.facetPlaneIndex[i]
        if (planeIndex < 0) return SITE_CLASS_COLORS[analysis.siteClass[i]] ?? '#B0BEC5'
        return FAMILY_COLORS[planes[planeIndex].family] ?? '#4FC3F7'
      }
      case 'element':
      default:
        return element.color
    }
  }

  keep.forEach((atomIndex, k) => {
    positions[k * 3] = positionsA[atomIndex * 3]
    positions[k * 3 + 1] = positionsA[atomIndex * 3 + 1]
    positions[k * 3 + 2] = positionsA[atomIndex * 3 + 2]
    const [r, g, b] = hexToRgb(colorOf(atomIndex))
    colors[k * 3] = r
    colors[k * 3 + 1] = g
    colors[k * 3 + 2] = b
  })

  return {
    positions,
    colors,
    atomIds: Int32Array.from(keep),
    visibleCount: keep.length,
    counts: { total, rendered: keep.length, hidden: total - keep.length },
  }
}
