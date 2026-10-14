import { specificSurfaceAreaM2PerG } from '../builder'
import type { LiteResult } from '../types'

function polygonName(vertexCount: number): string {
  switch (vertexCount) {
    case 3:
      return 'triangle'
    case 4:
      return 'square'
    case 6:
      return 'hexagon'
    case 8:
      return 'octagon'
    default:
      return `${vertexCount}-gon`
  }
}

/** Shape identification, facet table and particle statistics. */
export default function InfoPanel({ result }: { result: LiteResult | null }) {
  if (!result) {
    return (
      <section className="panel">
        <h2>Particle</h2>
        <p className="hint">Building the first particle…</p>
      </section>
    )
  }

  const byFamily = new Map<string, { count: number; area: number; shape: string }>()
  for (const facet of result.shape.facets) {
    const entry = byFamily.get(facet.family) ?? { count: 0, area: 0, shape: polygonName(facet.verticesA.length) }
    entry.count += 1
    entry.area += facet.areaA2
    byFamily.set(facet.family, entry)
  }

  const composition = [...byFamily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([family, entry]) => `${entry.count} × {${family}} ${entry.shape}`)
    .join(' + ')

  const total = result.analysis.nAtoms
  const ssa = specificSurfaceAreaM2PerG(result)

  return (
    <>
      <section className="panel">
        <h2>
          Particle <span className="ko">입자</span>
        </h2>
        <table className="kv">
          <tbody>
            <tr>
              <th>facets</th>
              <td>
                <b>{result.shape.facets.length}</b> · {composition}
              </td>
            </tr>
            <tr>
              <th>atoms</th>
              <td>
                <b>{total.toLocaleString()}</b> · surface {result.analysis.surfaceAtoms.toLocaleString()} (
                {((100 * result.analysis.surfaceAtoms) / Math.max(total, 1)).toFixed(1)} %) · bulk{' '}
                {result.analysis.bulkAtoms.toLocaleString()}
              </td>
            </tr>
            <tr>
              <th>diameter (achieved)</th>
              <td>{(result.shape.maxExtentA / 10).toFixed(3)} nm · requested {result.request.diameterNm.toFixed(2)} nm</td>
            </tr>
            <tr>
              <th>volume</th>
              <td>
                {result.shape.volumeA3.toFixed(3)} Å³ ({(result.shape.volumeA3 / 1000).toFixed(4)} nm³)
              </td>
            </tr>
            <tr>
              <th>surface area</th>
              <td>
                {result.shape.surfaceAreaA2.toFixed(3)} Å² ({(result.shape.surfaceAreaA2 / 100).toFixed(4)} nm²)
              </td>
            </tr>
            <tr>
              <th>specific surface area</th>
              <td>{ssa.toFixed(1)} m²/g</td>
            </tr>
            <tr>
              <th>max coordination</th>
              <td>{result.analysis.maxCn} (FCC bulk = 12)</td>
            </tr>
          </tbody>
        </table>
        {result.warnings.map((warning) => (
          <p key={warning} className="hint warn">
            {warning}
          </p>
        ))}
      </section>

      <section className="panel">
        <h2>
          Facets &amp; areas <span className="ko">결정면</span>
        </h2>
        <table className="kv compact">
          <thead>
            <tr>
              <th>plane</th>
              <th>count</th>
              <th>d (Å)</th>
              <th>area (Å²)</th>
              <th>terrace atoms</th>
            </tr>
          </thead>
          <tbody>
            {[...byFamily.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .map(([family, entry]) => {
                const plane = result.planes.find((p) => p.family === family)
                return (
                  <tr key={family}>
                    <th>{`{${family}}`}</th>
                    <td>{entry.count}</td>
                    <td>{plane ? plane.distanceA.toFixed(4) : '–'}</td>
                    <td>{entry.area.toFixed(1)}</td>
                    <td>{result.analysis.terraceByFamily[family] ?? 0}</td>
                  </tr>
                )
              })}
          </tbody>
        </table>
        <p className="hint">
          Facet areas come from the continuous ideal polyhedron; the terrace counts come from the discrete lattice.
          They agree within one lattice spacing, so small particles show larger relative differences.
        </p>
      </section>

      <section className="panel">
        <h2>
          Surface sites <span className="ko">표면</span>
        </h2>
        <table className="kv">
          <tbody>
            {Object.entries(result.analysis.classCounts).map(([key, count]) => (
              <tr key={key}>
                <th>{key}</th>
                <td>
                  {count.toLocaleString()}{' '}
                  <span className="dim small">({((100 * count) / Math.max(total, 1)).toFixed(2)} %)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          bulk = 12 neighbours; terrace = exactly one facet plane within 0.35 × a/√2 of the outermost occupied layer;
          edge = two planes; corner = three or more. Everything else on the surface is grouped as “other”.
        </p>
      </section>
    </>
  )
}
