import { ELEMENT_SYMBOLS, elementInfo } from '../elements'
import { CUSTOM_FAMILIES, MORPHOLOGIES } from '../morphologies'
import { MAX_ATOMS, MAX_DIAMETER_NM } from '../limits'
import type { ColorMode, ElementSymbol, MorphologyId, ViewState } from '../types'

export interface LiteParams {
  element: ElementSymbol
  morphology: MorphologyId
  diameterNm: number
  customWeights: Record<string, number>
  boundaryInclusion: 'center' | 'shell'
  latticeAlign: boolean
}

const COLOR_MODES: Array<{ id: ColorMode; label: string }> = [
  { id: 'element', label: 'Element' },
  { id: 'coordination', label: 'Coordination number' },
  { id: 'surface', label: 'Surface vs bulk' },
  { id: 'site_class', label: 'Site class (facet / edge / corner)' },
  { id: 'facet', label: 'Facet-associated atoms' },
]

/** All user controls. Everything is computed locally — there is no backend. */
export default function ControlPanel({
  params,
  onParams,
  view,
  onView,
  onExportXyz,
}: {
  params: LiteParams
  onParams: (patch: Partial<LiteParams>) => void
  view: ViewState
  onView: (patch: Partial<ViewState>) => void
  onExportXyz: () => void
}) {
  const element = elementInfo(params.element)
  const selected = MORPHOLOGIES.find((m) => m.id === params.morphology)

  return (
    <aside className="sidebar">
      <section className="panel">
        <h2>
          Element <span className="ko">원소</span>
        </h2>
        <div className="row-wrap">
          {ELEMENT_SYMBOLS.map((symbol) => (
            <button
              key={symbol}
              className={params.element === symbol ? 'chip active' : 'chip'}
              onClick={() => onParams({ element: symbol })}
              title={`${elementInfo(symbol).name} · a = ${elementInfo(symbol).latticeConstantA} Å`}
            >
              {symbol}
            </button>
          ))}
        </div>
        <table className="kv">
          <tbody>
            <tr>
              <th>lattice a</th>
              <td>{element.latticeConstantA.toFixed(4)} Å</td>
            </tr>
            <tr>
              <th>nearest neighbour a/√2</th>
              <td>{element.nearestNeighbourA.toFixed(6)} Å</td>
            </tr>
            <tr>
              <th>structure</th>
              <td>fcc (Fm-3m, cF4) · 4 atoms / cell</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>
          Morphology <span className="ko">형상</span>
        </h2>
        <div className="morph-list">
          {MORPHOLOGIES.map((morphology) => (
            <button
              key={morphology.id}
              className={params.morphology === morphology.id ? 'morph-item active' : 'morph-item'}
              onClick={() => onParams({ morphology: morphology.id })}
            >
              <span className="morph-label">{morphology.label}</span>
              <span className="morph-facets">{morphology.facetLabel}</span>
            </button>
          ))}
        </div>
        {selected && <p className="hint">{selected.description}</p>}
      </section>

      {params.morphology === 'custom' && (
        <section className="panel">
          <h2>
            Plane distances <span className="ko">면 거리</span>
          </h2>
          {CUSTOM_FAMILIES.map((family) => (
            <label key={family.key} className="slider-row">
              <span>
                {family.label} · d/d₀ = {(params.customWeights[family.key] ?? 0).toFixed(2)}
              </span>
              <input
                type="range"
                min={0.1}
                max={2.5}
                step={0.05}
                value={params.customWeights[family.key] ?? 1}
                onChange={(e) =>
                  onParams({
                    customWeights: { ...params.customWeights, [family.key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
          <p className="hint">
            Bigger distance = that face grows outwards; smaller = it is cut back and can disappear completely when
            another face reaches the surface first.
          </p>
        </section>
      )}

      <section className="panel">
        <h2>
          Size <span className="ko">크기</span>
        </h2>
        <label className="slider-row">
          <span>diameter {params.diameterNm.toFixed(2)} nm (max extent)</span>
          <input
            type="range"
            min={0.8}
            max={MAX_DIAMETER_NM}
            step={0.1}
            value={params.diameterNm}
            onChange={(e) => onParams({ diameterNm: Number(e.target.value) })}
          />
        </label>
        <p className="hint">
          The diameter is the largest extent of the ideal polyhedron, so it is measured vertex-to-vertex for
          {` {111}`}-bound shapes and face-to-face for cubes.
        </p>
      </section>

      <section className="panel">
        <h2>
          Lattice &amp; surface <span className="ko">격자</span>
        </h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={params.latticeAlign}
            onChange={(e) => onParams({ latticeAlign: e.target.checked })}
          />
          <span>align the dominant facet with an atomic plane</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={params.boundaryInclusion === 'shell'}
            onChange={(e) => onParams({ boundaryInclusion: e.target.checked ? 'shell' : 'center' })}
          />
          <span>include the outer atomic shell (atoms straddling the surface)</span>
        </label>
        <p className="hint">
          Off (default) = every atom centre is inside the ideal body. On = the outermost atomic layer is kept as
          well, which is closer to a real crystal cut.
        </p>
      </section>

      <section className="panel">
        <h2>
          Display <span className="ko">표시</span>
        </h2>
        <div className="color-modes">
          {COLOR_MODES.map((mode) => (
            <button
              key={mode.id}
              className={view.colorMode === mode.id ? 'chip tiny active' : 'chip tiny'}
              onClick={() => onView({ colorMode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <label className="slider-row">
          <span>sphere radius {(element.metallicRadiusA * view.metalRadiusScale * 0.62).toFixed(2)} Å (visual only)</span>
          <input
            type="range"
            min={0.4}
            max={2.2}
            step={0.05}
            value={view.metalRadiusScale}
            onChange={(e) => onView({ metalRadiusScale: Number(e.target.value) })}
          />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={view.showBulk} onChange={(e) => onView({ showBulk: e.target.checked })} />
          <span>show bulk (12-coordinated) atoms</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.showFacetOnly}
            onChange={(e) => onView({ showFacetOnly: e.target.checked })}
          />
          <span>only facet terrace atoms</span>
        </label>
      </section>

      <section className="panel">
        <h2>
          Export <span className="ko">내보내기</span>
        </h2>
        <button className="chip" onClick={onExportXyz}>
          Download XYZ
        </button>
        <p className="hint">
          Plain-text atomic coordinates, generated in the browser (same numbers as the viewer). Atom budget per
          request: {MAX_ATOMS.toLocaleString()} atoms — above that the request is refused instead of freezing the tab.
        </p>
      </section>
    </aside>
  )
}
