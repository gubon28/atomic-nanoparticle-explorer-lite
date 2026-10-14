/**
 * Scientific validation of the Lite (browser-only) engine.
 *
 * Part A — first-principles checks that need no reference data at all
 *          (FCC geometry, lattice validity, facet counts, determinism).
 * Part B — cross-validation against the frozen output of the Full Python engine
 *          (`tests/fixtures/full-engine.json`, produced by tools/make_fixtures.py):
 *          the ACTUAL atomic coordinate sets, coordination numbers, surface/bulk
 *          classification, facet assignments, plane geometry, volumes and areas.
 *
 * Tolerances are stated per category:
 *   coordinates  1e-9 A        (exact lattice multiples, solved in float64)
 *   integers     exact         (CN, site class, facet index, atom counts)
 *   volumes      1e-12 relative
 *   areas        1e-12 relative
 *   spacings     1e-12 absolute (A)
 */

import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/full-engine.json'
import { buildNanoparticle, specificSurfaceAreaM2PerG } from '../src/builder'
import { elementInfo, ELEMENT_SYMBOLS } from '../src/elements'
import { nearestNeighbourDistance } from '../src/lattice'
import { MAX_ATOMS, LimitExceededError } from '../src/limits'
import { MORPHOLOGIES } from '../src/morphologies'
import { buildPlanes, buildShape } from '../src/shapeBuilder'
import { runSelfChecks } from '../src/validate'
import type { ElementSymbol, MorphologyId } from '../src/types'

const TOL_COORD_A = 1e-9
const TOL_REL_VOLUME = 1e-12
const TOL_REL_AREA = 1e-12
const TOL_ABS_SPACING = 1e-12

type Fixture = (typeof fixtures)['cases'][number]
const CASES = fixtures.cases as Fixture[]

function buildFromFixture(fixture: Fixture) {
  return buildNanoparticle({
    element: fixture.request.element as ElementSymbol,
    morphology: fixture.request.morphology as MorphologyId,
    diameterNm: fixture.request.diameterNm,
    customWeights: fixture.request.customWeights as Record<string, number> | null,
    boundaryInclusion: fixture.request.boundaryInclusion as 'center' | 'shell',
    latticeAlign: fixture.request.latticeAlign,
  })
}

function maxCoordDeviation(a: Float64Array, b: number[][]): number {
  let worst = 0
  for (let i = 0; i < b.length; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      worst = Math.max(worst, Math.abs(a[i * 3 + c] - b[i][c]))
    }
  }
  return worst
}

// ---------------------------------------------------------------------------
// Part A — first principles
// ---------------------------------------------------------------------------

describe('FCC geometry (first principles)', () => {
  it('nearest-neighbour distance is a/sqrt(2) for every supported metal', () => {
    // closed form first: d_nn = a / sqrt(2) exactly
    for (const symbol of ELEMENT_SYMBOLS) {
      const info = elementInfo(symbol)
      expect(Math.abs(nearestNeighbourDistance(info.latticeConstantA) - info.latticeConstantA / Math.SQRT2)).toBeLessThan(
        1e-15,
      )
    }
    // and against independently computed values a/sqrt(2) (7 significant figures)
    const expected: Record<ElementSymbol, number> = {
      Au: 2.8837229,
      Ag: 2.8887433,
      Pt: 2.7748284,
      Pd: 2.7511404,
      Cu: 2.5561203,
    }
    for (const symbol of ELEMENT_SYMBOLS) {
      const info = elementInfo(symbol)
      expect(Math.abs(info.nearestNeighbourA - expected[symbol])).toBeLessThan(1e-6)
    }
  })

  it('every atom of every preset sits on an FCC site (a/2 grid, even parity)', () => {
    for (const morphology of MORPHOLOGIES) {
      const result = buildNanoparticle({
        element: 'Au',
        morphology: morphology.id,
        diameterNm: 2.0,
        customWeights: morphology.id === 'custom' ? { '100': 1, '110': 1, '111': 1 } : null,
        boundaryInclusion: 'center',
        latticeAlign: false,
      })
      const a = result.element.latticeConstantA
      for (let i = 0; i < result.analysis.nAtoms; i += 1) {
        const xi = Math.round((result.positionsA[i * 3] / a) * 2)
        const yi = Math.round((result.positionsA[i * 3 + 1] / a) * 2)
        const zi = Math.round((result.positionsA[i * 3 + 2] / a) * 2)
        expect(Math.abs((result.positionsA[i * 3] / a) * 2 - xi)).toBeLessThan(1e-9)
        expect(Math.abs((result.positionsA[i * 3 + 1] / a) * 2 - yi)).toBeLessThan(1e-9)
        expect(Math.abs((result.positionsA[i * 3 + 2] / a) * 2 - zi)).toBeLessThan(1e-9)
        expect(Math.abs(xi + yi + zi) % 2).toBe(0)
      }
    }
  })

  it('facet counts and areas match the crystallography of each preset', () => {
    const expectedFacets: Partial<Record<MorphologyId, number>> = {
      cube: 6,
      octahedron: 8,
      rhombic_dodecahedron: 12,
      truncated_octahedron: 14,
      cuboctahedron: 14,
    }
    for (const [morphology, count] of Object.entries(expectedFacets)) {
      const result = buildNanoparticle({
        element: 'Au',
        morphology: morphology as MorphologyId,
        diameterNm: 2.0,
        boundaryInclusion: 'center',
        latticeAlign: false,
      })
      expect(result.shape.facets.length).toBe(count)
      // every facet normal is the unit normal of its Miller index
      for (const facet of result.shape.facets) {
        const norm = Math.hypot(...facet.miller)
        const dot = facet.normal[0] * facet.miller[0] + facet.normal[1] * facet.miller[1] + facet.normal[2] * facet.miller[2]
        expect(Math.abs(1 - dot / norm)).toBeLessThan(1e-15)
      }
    }
  })

  it('the cube volume and area agree with the closed form (2.0 nm Au: 8000 A^3, 2400 A^2)', () => {
    const result = buildNanoparticle({
      element: 'Au',
      morphology: 'cube',
      diameterNm: 2.0,
      boundaryInclusion: 'center',
      latticeAlign: false,
    })
    expect(Math.abs(result.shape.volumeA3 - 8000) / 8000).toBeLessThan(TOL_REL_VOLUME)
    expect(Math.abs(result.shape.surfaceAreaA2 - 2400) / 2400).toBeLessThan(TOL_REL_AREA)
    expect(result.analysis.nAtoms).toBe(365)
  })

  it('is deterministic: identical requests give identical coordinates', () => {
    const request = {
      element: 'Au' as ElementSymbol,
      morphology: 'truncated_octahedron' as MorphologyId,
      diameterNm: 2.5,
      boundaryInclusion: 'center' as const,
      latticeAlign: false,
    }
    const first = buildNanoparticle(request)
    const second = buildNanoparticle(request)
    expect(second.positionsA.length).toBe(first.positionsA.length)
    let worst = 0
    for (let i = 0; i < first.positionsA.length; i += 1) {
      worst = Math.max(worst, Math.abs(second.positionsA[i] - first.positionsA[i]))
    }
    expect(worst).toBe(0) // bit-identical, no randomness anywhere
  })

  it('refuses requests above the browser atom budget instead of freezing', () => {
    expect(() =>
      buildNanoparticle({
        element: 'Au',
        morphology: 'cube',
        diameterNm: 18,
        boundaryInclusion: 'center',
        latticeAlign: false,
      }),
    ).toThrow(LimitExceededError)
    // and the guard is a real budget, not a toy: an 8 nm truncated octahedron fits
    const big = buildNanoparticle({
      element: 'Au',
      morphology: 'truncated_octahedron',
      diameterNm: 8,
      boundaryInclusion: 'center',
      latticeAlign: false,
    })
    expect(big.analysis.nAtoms).toBeGreaterThan(10_000)
    expect(big.analysis.nAtoms).toBeLessThanOrEqual(MAX_ATOMS)
  })

  it('reports a specific surface area that scales as 1/size', () => {
    const small = buildNanoparticle({
      element: 'Au',
      morphology: 'cube',
      diameterNm: 2,
      boundaryInclusion: 'center',
      latticeAlign: false,
    })
    const large = buildNanoparticle({
      element: 'Au',
      morphology: 'cube',
      diameterNm: 6,
      boundaryInclusion: 'center',
      latticeAlign: false,
    })
    const ssaSmall = specificSurfaceAreaM2PerG(small)
    const ssaLarge = specificSurfaceAreaM2PerG(large)
    expect(ssaLarge).toBeLessThan(ssaSmall)
    expect(ssaSmall / ssaLarge).toBeGreaterThan(2.4) // ~3x, slightly less from the discrete layer
  })

  it('passes its own in-browser self-checks', () => {
    for (const morphology of ['cube', 'octahedron', 'truncated_octahedron', 'cuboctahedron'] as MorphologyId[]) {
      const result = buildNanoparticle({
        element: 'Au',
        morphology,
        diameterNm: 2.0,
        boundaryInclusion: 'center',
        latticeAlign: false,
      })
      const failed = runSelfChecks(result).filter((check) => !check.passed)
      expect(failed.map((check) => check.id)).toEqual([])
    }
  })

  it('builds the polyhedron from plane triples without a hull library', () => {
    // hand-built cube: 6 planes at distance 5 A  ->  V = 1000 A^3
    const planes = buildPlanes(4.0782, { '100': 1 }, { '100': 5 })
    const shape = buildShape(planes)
    expect(Math.abs(shape.volumeA3 - 1000) / 1000).toBeLessThan(1e-12)
    expect(shape.verticesA.length).toBe(8)
    expect(shape.facets.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Part B — cross-validation against the Full Python engine
// ---------------------------------------------------------------------------

describe('cross-validation with the Full (Python) engine', () => {
  it('has 12 frozen reference cases', () => {
    expect(CASES.length).toBe(12)
  })

  for (const fixture of CASES) {
    describe(`${fixture.id} (${fixture.nAtoms} reference atoms)`, () => {
      const result = buildFromFixture(fixture)

      it('produces exactly the same atom count', () => {
        expect(result.analysis.nAtoms).toBe(fixture.nAtoms)
      })

      it('reproduces the actual atomic coordinates (per-atom, 1e-9 A)', () => {
        expect(result.positionsA.length / 3).toBe(fixture.positionsA.length)
        const worst = maxCoordDeviation(result.positionsA, fixture.positionsA)
        expect(worst).toBeLessThan(TOL_COORD_A)
      })

      it('reproduces every coordination number', () => {
        const mine = Array.from(result.analysis.cn)
        expect(mine).toEqual(fixture.coordination)
      })

      it('reproduces the surface/bulk and site classification', () => {
        expect(Array.from(result.analysis.siteClass)).toEqual(fixture.siteClass)
        expect(result.analysis.bulkAtoms).toBe(fixture.classCounts.bulk)
        expect(result.analysis.surfaceAtoms).toBe(fixture.surfaceAtoms)
        expect(result.analysis.classCounts.facet).toBe(fixture.classCounts.facet)
        expect(result.analysis.classCounts.edge).toBe(fixture.classCounts.edge)
        expect(result.analysis.classCounts.corner).toBe(fixture.classCounts.corner)
        expect(result.analysis.classCounts.surface_other).toBe(fixture.classCounts.surface_other)
      })

      it('reproduces the facet assignment of every terrace atom', () => {
        expect(Array.from(result.analysis.facetPlaneIndex)).toEqual(fixture.facetPlaneIndex)
        expect(Array.from(result.analysis.facetId)).toEqual(fixture.facetId)
      })

      it('reproduces the plane geometry (distances, spacings, Miller indices)', () => {
        expect(result.planes.length).toBe(fixture.planes.length)
        fixture.planes.forEach((plane, i) => {
          expect(result.planes[i].family).toBe(plane.family)
          expect(result.planes[i].miller).toEqual(plane.miller)
          expect(Math.abs(result.planes[i].distanceA - plane.distanceA)).toBeLessThan(TOL_ABS_SPACING)
          expect(Math.abs(result.planes[i].spacingA - plane.spacingA)).toBeLessThan(TOL_ABS_SPACING)
        })
      })

      it('reproduces the polyhedron volume, surface area and size', () => {
        expect(Math.abs(result.shape.volumeA3 - fixture.volumeA3) / fixture.volumeA3).toBeLessThan(TOL_REL_VOLUME)
        expect(Math.abs(result.shape.surfaceAreaA2 - fixture.surfaceAreaA2) / fixture.surfaceAreaA2).toBeLessThan(TOL_REL_AREA)
        expect(Math.abs(result.shape.maxExtentA - fixture.maxExtentA)).toBeLessThan(1e-9)
        expect(Math.abs(result.shape.maxExtentA / 10 - fixture.achievedDiameterNm)).toBeLessThan(1e-9)
      })

      it('reproduces every facet area', () => {
        expect(result.shape.facets.length).toBe(fixture.facets.length)
        const mine = [...result.shape.facets].sort((a, b) =>
          a.family.localeCompare(b.family) || a.miller.join().localeCompare(b.miller.join()),
        )
        const theirs = [...fixture.facets].sort((a, b) =>
          a.family.localeCompare(b.family) || a.miller.join().localeCompare(b.miller.join()),
        )
        mine.forEach((facet, i) => {
          expect(facet.family).toBe(theirs[i].family)
          expect(facet.miller).toEqual(theirs[i].miller)
          expect(Math.abs(facet.areaA2 - theirs[i].areaA2) / theirs[i].areaA2).toBeLessThan(TOL_REL_AREA)
        })
      })

      it('reproduces the terrace atom counts per family', () => {
        const reference: Record<string, number> = {}
        fixture.facetPlaneIndex.forEach((planeIndex, atomIndex) => {
          void atomIndex
          if (planeIndex < 0) return
          const family = fixture.planes[planeIndex].family
          reference[family] = (reference[family] ?? 0) + 1
        })
        for (const [family, count] of Object.entries(reference)) {
          expect(result.analysis.terraceByFamily[family]).toBe(count)
        }
      })
    })
  }
})
