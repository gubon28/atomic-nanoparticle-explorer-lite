import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import ControlPanel, { type LiteParams } from './components/ControlPanel'
import InfoPanel from './components/InfoPanel'
import ValidationPanel from './components/ValidationPanel'
import Viewer from './components/Viewer'
import { buildNanoparticle } from './builder'
import { buildRenderData } from './colors'
import { downloadText, toXyz } from './exportXyz'
import { elementInfo } from './elements'
import type { LiteResult, ViewState } from './types'

const DEFAULT_PARAMS: LiteParams = {
  element: 'Au',
  morphology: 'truncated_octahedron',
  diameterNm: 3.0,
  customWeights: { '100': 1, '110': 1, '111': 1 },
  boundaryInclusion: 'center',
  latticeAlign: false,
}

const DEFAULT_VIEW: ViewState = {
  colorMode: 'coordination',
  metalRadiusScale: 1,
  showBulk: true,
  showFacetOnly: false,
  cameraMode: 'perspective',
  showFacetPlanes: false,
  showDirections: true,
  showWireframe: true,
  quality: 'medium',
}

const EMPTY_RENDER = {
  positions: new Float32Array(0),
  colors: new Float32Array(0),
  atomIds: new Int32Array(0),
  visibleCount: 0,
  counts: { total: 0, rendered: 0, hidden: 0 },
}

export default function App() {
  const [params, setParams] = useState<LiteParams>(DEFAULT_PARAMS)
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW)
  const [result, setResult] = useState<LiteResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [computing, setComputing] = useState(true)
  const captureRef = useRef<(() => string | null) | null>(null)

  const paramsKey = useMemo(() => JSON.stringify(params), [params])

  const onParams = useCallback((patch: Partial<LiteParams>) => {
    setParams((prev) => ({ ...prev, ...patch }))
  }, [])

  const onView = useCallback((patch: Partial<ViewState>) => {
    setView((prev) => ({ ...prev, ...patch }))
  }, [])

  // The heavy work is deferred by one task so the "computing…" state can paint
  // first; the engine itself refuses requests above the atom budget.
  useEffect(() => {
    setComputing(true)
    const handle = window.setTimeout(() => {
      try {
        const built = buildNanoparticle({
          element: params.element,
          morphology: params.morphology,
          diameterNm: params.diameterNm,
          customWeights: params.morphology === 'custom' ? params.customWeights : null,
          boundaryInclusion: params.boundaryInclusion,
          latticeAlign: params.latticeAlign,
        })
        setResult(built)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setComputing(false)
      }
    }, 80)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey])

  const renderData = useMemo(() => {
    if (!result) return EMPTY_RENDER
    return buildRenderData(result, {
      colorMode: view.colorMode,
      showBulk: view.showBulk,
      showFacetOnly: view.showFacetOnly,
    })
  }, [result, view.colorMode, view.showBulk, view.showFacetOnly])

  const element = elementInfo(params.element)
  const sphereRadius = element.metallicRadiusA * view.metalRadiusScale * 0.62

  const onExportXyz = useCallback(() => {
    if (!result) return
    downloadText(`${result.element.symbol}_${result.morphology.id}_${result.analysis.nAtoms}atoms.xyz`, toXyz(result))
  }, [result])

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <h1>Atomic Nanoparticle Explorer · Lite</h1>
            <p>
              Ideal FCC metal nanoparticles built from crystallographic half-spaces ·{' '}
              <b>all calculations run locally in your browser — no server, no upload</b>
            </p>
          </div>
        </div>
        <div className="header-stats">
          {result && (
            <>
              <span>
                <b>{result.analysis.nAtoms.toLocaleString()}</b> atoms
              </span>
              <span>
                <b>{result.shape.facets.length}</b> facets
              </span>
              <span>
                <b>{result.computeMs.toFixed(1)}</b> ms
              </span>
            </>
          )}
        </div>
      </header>

      <div className="grid">
        <ControlPanel params={params} onParams={onParams} view={view} onView={onView} onExportXyz={onExportXyz} />

        <main className="center">
          {error ? (
            <div className="error-box">
              <h2>Request refused</h2>
              <p>{error}</p>
              <p className="hint">
                Lite runs on one browser thread, so it keeps a hard budget of 30,000 atoms (about 9 nm for a
                truncated octahedron). Reduce the diameter to continue.
              </p>
            </div>
          ) : (
            <Viewer
              result={result}
              renderData={renderData}
              view={view}
              onView={onView}
              sphereRadius={sphereRadius}
              computing={computing}
              captureRef={captureRef}
            />
          )}
        </main>

        <div className="right">
          <InfoPanel result={result} />
          <ValidationPanel result={result} />
        </div>
      </div>

      <footer className="footer">
        <span>
          Lite edition — convex {`{100}`} / {`{110}`} / {`{111}`} shapes only. Advanced features (high-index facets
          such as {`{210}`}–{`{321}`}, concave pits, nanorods / nanoplates, multiply twinned clusters, atomic
          measurement and column projection) live in the full desktop edition.
        </span>
        <span>
          Ideal, unrelaxed models: exact FCC sites, no surface relaxation, reconstruction, adsorbates or temperature.
        </span>
      </footer>
    </div>
  )
}
