/**
 * Performance benchmark of the local (browser) engine.
 *
 * Run with:  npx vitest run tests/benchmark.test.ts --reporter=verbose
 *
 * The numbers printed here are produced by the exact code the browser runs, so
 * they are a fair estimate of the interactive cost on the user's machine
 * (Chrome's V8 is the same engine as Node's).
 */

import { describe, expect, it } from 'vitest'
import { buildNanoparticle } from '../src/builder'
import type { ElementSymbol, MorphologyId } from '../src/types'

const CASES: Array<[ElementSymbol, MorphologyId, number]> = [
  ['Au', 'cube', 2],
  ['Au', 'cube', 4],
  ['Au', 'cube', 6],
  ['Au', 'octahedron', 4],
  ['Au', 'truncated_octahedron', 2],
  ['Au', 'truncated_octahedron', 5],
  ['Au', 'truncated_octahedron', 8],
  ['Ag', 'cube', 4],
  ['Cu', 'truncated_octahedron', 4],
  ['Pt', 'rhombic_dodecahedron', 5],
]

describe('local computation cost', () => {
  it('stays inside an interactive budget for every allowed size', () => {
    const rows: string[] = []
    let worst = 0
    for (const [element, morphology, diameter] of CASES) {
      const started = performance.now()
      const result = buildNanoparticle({
        element,
        morphology,
        diameterNm: diameter,
        boundaryInclusion: 'center',
        latticeAlign: false,
      })
      const ms = performance.now() - started
      worst = Math.max(worst, ms)
      rows.push(
        `  ${element} ${morphology} ${diameter.toFixed(1)} nm`.padEnd(42) +
          `atoms=${String(result.analysis.nAtoms).padStart(6)}  ` +
          `facets=${String(result.shape.facets.length).padStart(2)}  ` +
          `${ms.toFixed(1).padStart(7)} ms  ` +
          `${(result.analysis.nAtoms / Math.max(ms, 0.01)).toFixed(0).padStart(6)} atoms/ms`,
      )
    }
    // eslint-disable-next-line no-console
    console.log(['local engine benchmark (generation + analysis):', ...rows].join('\n'))
    // generous bound: the slowest allowed request must stay well below a freeze
    expect(worst).toBeLessThan(4000)
  })
})
