import { CN_MAX, CN_MIN, CN_RAMP, coordinationColor, FAMILY_COLORS, SITE_CLASS_COLORS } from '../colors'
import { CLASS_LABELS } from '../analysis'
import type { LiteResult, ViewState } from '../types'

/** Colour legend for the active colour mode. */
export default function ColorLegend({ view, result }: { view: ViewState; result: LiteResult | null }) {
  if (!result) return null

  if (view.colorMode === 'coordination') {
    const steps = Array.from({ length: CN_MAX - CN_MIN + 1 }, (_, i) => CN_MIN + i)
    return (
      <div className="legend">
        <span className="legend-title">Coordination number</span>
        <div className="legend-row">
          {steps.map((cn) => (
            <span key={cn} className="legend-swatch-wrap">
              <span className="legend-swatch" style={{ background: coordinationColor(cn) }} />
              <span className="legend-tick">{cn}</span>
            </span>
          ))}
        </div>
        <span className="legend-note">
          bulk FCC = 12 · radial cut-off {result.cutoffA.toFixed(3)} Å (1.2 × a/√2)
        </span>
      </div>
    )
  }

  if (view.colorMode === 'surface' || view.colorMode === 'site_class') {
    const rows =
      view.colorMode === 'surface'
        ? [
            { color: '#FF9F45', label: `surface · CN < 12 · ${result.analysis.surfaceAtoms}` },
            { color: '#3C4A5E', label: `bulk · CN = 12 · ${result.analysis.bulkAtoms}` },
          ]
        : Object.entries(result.analysis.classCounts)
            .filter(([, count]) => count > 0)
            .map(([key, count]) => {
              const index = Number(Object.keys(CLASS_LABELS).find((k) => CLASS_LABELS[Number(k)].startsWith(key)) ?? 0)
              return {
                color: SITE_CLASS_COLORS[index] ?? '#B0BEC5',
                label: `${key} · ${count}`,
              }
            })
    return (
      <div className="legend">
        <span className="legend-title">{view.colorMode === 'surface' ? 'Surface vs bulk' : 'Site class'}</span>
        <div className="legend-row">
          {rows.map((row) => (
            <span key={row.label} className="legend-swatch-wrap">
              <span className="legend-swatch" style={{ background: row.color }} />
              <span className="legend-tick">{row.label}</span>
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (view.colorMode === 'facet') {
    const families = [...new Set(result.planes.map((p) => p.family))].sort()
    return (
      <div className="legend">
        <span className="legend-title">Facet-associated surface atoms</span>
        <div className="legend-row">
          {families.map((family) => (
            <span key={family} className="legend-swatch-wrap">
              <span className="legend-swatch" style={{ background: FAMILY_COLORS[family] ?? '#4FC3F7' }} />
              <span className="legend-tick">
                {'{' + family + '}'} terrace · {result.analysis.terraceByFamily[family] ?? 0}
              </span>
            </span>
          ))}
          <span className="legend-swatch-wrap">
            <span className="legend-swatch" style={{ background: SITE_CLASS_COLORS[2] }} />
            <span className="legend-tick">edge</span>
          </span>
          <span className="legend-swatch-wrap">
            <span className="legend-swatch" style={{ background: SITE_CLASS_COLORS[3] }} />
            <span className="legend-tick">corner</span>
          </span>
          <span className="legend-swatch-wrap">
            <span className="legend-swatch" style={{ background: CN_RAMP[0] }} />
            <span className="legend-tick">other surface</span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="legend">
      <span className="legend-title">Element</span>
      <div className="legend-row">
        <span className="legend-swatch-wrap">
          <span className="legend-swatch" style={{ background: result.element.color }} />
          <span className="legend-tick">
            {result.element.symbol} ({result.element.name}) · a = {result.element.latticeConstantA.toFixed(4)} Å
          </span>
        </span>
      </div>
    </div>
  )
}
