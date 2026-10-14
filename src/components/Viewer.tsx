import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFullscreen } from '../useFullscreen'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import AtomCloud from './AtomCloud'
import FacetOverlay from './FacetOverlay'
import ShapeOutline from './ShapeOutline'
import DirectionAxes from './DirectionAxes'
import ColorLegend from './ColorLegend'
import { MOBILE_QUERY, MOBILE_STAGE_INSET, useMediaQuery } from '../useMediaQuery'
import type { RenderData } from '../colors'
import type { LiteResult, ViewState } from '../types'

interface ViewerProps {
  result: LiteResult | null
  renderData: RenderData
  view: ViewState
  onView: (patch: Partial<ViewState>) => void
  sphereRadius: number
  computing: boolean
  captureRef: MutableRefObject<(() => string | null) | null>
}

function CaptureBridge({ captureRef }: { captureRef: MutableRefObject<(() => string | null) | null> }) {
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    captureRef.current = () => {
      gl.render(scene, camera)
      return gl.domElement.toDataURL('image/png')
    }
    return () => {
      captureRef.current = null
    }
  }, [gl, scene, camera, captureRef])
  return null
}

/**
 * Read-only inspection hook used by tools/layout_check.py (and handy in the
 * browser console): it exposes the live camera projection so the particle centre
 * and the aspect ratio can be verified programmatically.
 */
function DebugBridge({ radius }: { radius: number }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  useEffect(() => {
    const api = {
      snapshot: () => {
        const perspective = camera as THREE.PerspectiveCamera
        const ortho = camera as THREE.OrthographicCamera
        const centre = new THREE.Vector3(0, 0, 0).project(camera)
        return {
          type: ortho.isOrthographicCamera ? 'orthographic' : 'perspective',
          fov: perspective.isPerspectiveCamera ? perspective.fov : null,
          zoom: ortho.isOrthographicCamera ? ortho.zoom : null,
          aspect: perspective.isPerspectiveCamera ? perspective.aspect : width / Math.max(height, 1),
          distance: camera.position.length(),
          radius,
          center_ndc: [centre.x, centre.y],
          canvas: { width: gl.domElement.clientWidth, height: gl.domElement.clientHeight },
        }
      },
    }
    ;(window as unknown as Record<string, unknown>).__liteDebug = api
    return () => {
      delete (window as unknown as Record<string, unknown>).__liteDebug
    }
  }, [camera, gl, width, height, radius])
  return null
}

/**
 * Exact camera fit.
 *
 * Instead of guessing a bounding-sphere radius (the circumradius of a truncated
 * octahedron is ~1.41x the half bounding-box extent, which would blow the particle
 * up well past the target), every polyhedron vertex is projected into the camera
 * frame and the distance/zoom is solved so that the projected bounding box covers
 * exactly `FILL_TARGET` of the shorter viewport side — in both axes, for both
 * camera types, at any viewport size.
 */
const FILL_TARGET = 0.55

function CameraRig({
  vertices,
  cameraMode,
  resetToken,
  onFit,
  inset,
}: {
  vertices: ReadonlyArray<[number, number, number]>
  cameraMode: ViewState['cameraMode']
  resetToken: number
  onFit: (distance: number) => void
  /** permanent overlay inset (px) reserved symmetrically at the top and bottom */
  inset: number
}) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3; update?: () => void } | null
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)

  useEffect(() => {
    if (width < 40 || height < 40 || vertices.length < 4) return
    // Frame the particle inside the UNOBSTRUCTED part of the stage: the compact
    // toolbar (top) and the HUD (bottom) are permanent overlays, so the same inset
    // is reserved on both sides and the particle stays centred in what the user can
    // actually see (and occupancy is measured against that band).
    // The toolbar and the HUD are horizontal strips: they only consume height, so
    // the width stays fully usable and the same inset is reserved top and bottom.
    const effWidth = Math.max(40, width)
    const effHeight = Math.max(40, height - 2 * inset)
    const dir = new THREE.Vector3(0.62, 0.48, 0.82).normalize() // origin -> camera
    const zAxis = dir.clone() // camera +Z
    const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize()
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize()
    const aspect = effWidth / Math.max(effHeight, 1)
    // fraction of the FULL viewport that equals FILL_TARGET of the visible band
    const fillY = (FILL_TARGET * effHeight) / height
    const fillX = (FILL_TARGET * effWidth) / width

    let lateralX = 0
    let lateralY = 0
    // the depth term is solved per vertex, so track the worst case
    let needOrthoX = 0
    let needOrthoY = 0

    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      for (const v of vertices) {
        const vec = new THREE.Vector3(v[0], v[1], v[2])
        lateralX = Math.max(lateralX, Math.abs(vec.dot(xAxis)))
        lateralY = Math.max(lateralY, Math.abs(vec.dot(yAxis)))
      }
      // world half-height = height / (2 * zoom): keep the bbox inside FILL_TARGET
      needOrthoY = (effHeight * FILL_TARGET) / (2 * Math.max(lateralY, 1e-6))
      needOrthoX = (effWidth * FILL_TARGET) / (2 * Math.max(lateralX, 1e-6))
      const ortho = camera as THREE.OrthographicCamera
      ortho.zoom = Math.min(needOrthoY, needOrthoX)
      ;(camera as THREE.OrthographicCamera).position.copy(dir.clone().multiplyScalar(Math.max(60, height)))
      onFit(Math.max(60, height))
    } else {
      const tanHalf = Math.tan(((camera as THREE.PerspectiveCamera).fov ?? 38) * Math.PI / 360)
      let distance = 0
      for (const v of vertices) {
        const vec = new THREE.Vector3(v[0], v[1], v[2])
        const depthOffset = vec.dot(zAxis)
        const needY = Math.abs(vec.dot(yAxis)) / (fillY * tanHalf) + depthOffset
        const needX = Math.abs(vec.dot(xAxis)) / (fillX * tanHalf * aspect) + depthOffset
        distance = Math.max(distance, needY, needX)
      }
      distance = Math.max(distance, 1e-3)
      camera.position.copy(dir.clone().multiplyScalar(distance))
      camera.near = Math.max(0.05, distance / 900)
      camera.far = distance * 120
      onFit(distance)
    }
    camera.updateProjectionMatrix()
    if (controls?.target) {
      controls.target.set(0, 0, 0)
      controls.update?.()
    }
    // remember the fitted framing so "Reset view" can return to exactly this pose
    ;(controls as { saveState?: () => void } | null)?.saveState?.()
  }, [camera, controls, vertices, cameraMode, resetToken, width, height, inset, onFit])

  return null
}

export default function Viewer({
  result,
  renderData,
  view,
  onView,
  sphereRadius,
  computing,
  captureRef,
}: ViewerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<unknown>(null)
  const [resetToken, setResetToken] = useState(0)
  const [fitDistance, setFitDistance] = useState(0)
  const fullscreen = useFullscreen(wrapperRef)
  const isMobile = useMediaQuery(MOBILE_QUERY)
  // Mobile: the settings panel and the CN legend are collapsible and live BELOW the
  // stage in normal mode, so nothing permanent is drawn over the particle.
  const [showSettings, setShowSettings] = useState(false)
  const [showLegend, setShowLegend] = useState(false)
  // in fullscreen there is no room below the stage: the same panels float instead,
  // and they are dismissible
  const panelsFloat = isMobile && fullscreen.isFullscreen

  const size = result ? result.shape.maxExtentA : 40
  const segments = view.quality === 'low' ? 8 : view.quality === 'medium' ? 14 : renderData.counts.total > 8000 ? 12 : 20

  // the exact fit needs the polyhedron vertices (the circumradius is easily 1.4x
  // the half bounding-box extent, so `size / 2` would overshoot badly)
  const fitVertices = useMemo(() => {
    if (!result) return []
    const vertices = result.shape.verticesA ?? []
    if (vertices.length >= 4) return vertices
    return result.shape.facets.flatMap((facet) => facet.verticesA)
  }, [result])

  const onFit = useCallback((distance: number) => setFitDistance(distance), [])
  // the fit distance defines the zoom range, so a large particle can never be
  // clamped by a fixed maxDistance (that clamp used to shrink the scene)
  const minDistance = Math.max(fitDistance * 0.35, size * 0.06)
  const maxDistance = Math.max(fitDistance * 4, size * 12)

  const downloadPng = () => {
    const url = captureRef.current?.()
    if (!url || !result) return
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${result.element.symbol}_${result.morphology.id}_${result.analysis.nAtoms}atoms.png`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  }

  return (
    <>
      <div className="viewer" ref={wrapperRef}>
      <Canvas
        flat
        dpr={[1, 2]}
        gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
        /* absolute positioning: the drawing buffer always matches the viewer box,
           independent of percentage-height resolution in the layout chain */
        style={{ position: 'absolute', inset: 0, background: 'transparent', display: 'block' }}
      >
        <hemisphereLight intensity={0.85} groundColor="#16202e" color="#dce6f5" />
        <directionalLight position={[1, 1.4, 0.9]} intensity={1.5} />
        <directionalLight position={[-1.2, -0.6, -1]} intensity={0.5} color="#9fc2ff" />

        {view.cameraMode === 'perspective' ? (
          <PerspectiveCamera makeDefault fov={38} near={0.1} far={4000} />
        ) : (
          <OrthographicCamera makeDefault near={0.1} far={4000} zoom={40} />
        )}
        <CameraRig
          vertices={fitVertices}
          cameraMode={view.cameraMode}
          resetToken={resetToken}
          onFit={onFit}
          inset={isMobile ? MOBILE_STAGE_INSET : 0}
        />

        {result && renderData.visibleCount > 0 && (
          <AtomCloud data={renderData} radius={sphereRadius} segments={segments} />
        )}

        {result && view.showWireframe && <ShapeOutline facets={result.shape.facets} />}
        {result && view.showFacetPlanes && <FacetOverlay facets={result.shape.facets} />}
        {result && view.showDirections && <DirectionAxes length={size * 0.6} />}

        <OrbitControls
          /* remounting on reset is the only reliable way to clear the controls'
             internal pan offset / inertia state */
          key={resetToken}
          ref={controlsRef as never}
          makeDefault
          enableDamping
          dampingFactor={0.12}
          rotateSpeed={0.85}
          zoomSpeed={0.9}
          panSpeed={0.8}
          minDistance={minDistance}
          maxDistance={maxDistance}
        />
        <CaptureBridge captureRef={captureRef} />
        <DebugBridge radius={size / 2} />
      </Canvas>

      <div className={isMobile ? 'viewer-toolbar compact' : 'viewer-toolbar'}>
        {isMobile ? (
          <div className="toolbar-group compact-bar">
            <button
              className="chip icon-btn"
              onClick={() => setResetToken((token) => token + 1)}
              title="Reset the camera"
              aria-label="Reset view"
            >
              ⟲ <span className="icon-label">Reset</span>
            </button>
            <button
              className={fullscreen.isFullscreen ? 'chip icon-btn active' : 'chip icon-btn'}
              onClick={() => {
                void fullscreen.toggle()
              }}
              title={
                fullscreen.supported
                  ? 'Fill the whole screen with the viewer (Esc leaves fullscreen)'
                  : 'Fullscreen is not available in this browser'
              }
              aria-label={fullscreen.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              data-testid="fullscreen-toggle"
            >
              {fullscreen.isFullscreen ? '⤢' : '⛶'}
            </button>
            <button
              className={showLegend ? 'chip icon-btn compact active' : 'chip icon-btn compact'}
              onClick={() => setShowLegend((value) => !value)}
              aria-expanded={showLegend}
              aria-controls="mobile-cn-legend"
              title="Coordination-number legend (opens below the viewer)"
            >
              CN
            </button>
            <button
              className={view.cameraMode === 'orthographic' ? 'chip icon-btn compact active' : 'chip icon-btn compact'}
              onClick={() =>
                onView({ cameraMode: view.cameraMode === 'orthographic' ? 'perspective' : 'orthographic' })
              }
              title="Toggle perspective / orthographic projection"
              aria-label={view.cameraMode === 'orthographic' ? 'Switch to perspective' : 'Switch to orthographic'}
            >
              {view.cameraMode === 'orthographic' ? 'Orth' : 'Persp'}
            </button>
            <button
              className={showSettings ? 'chip icon-btn active' : 'chip icon-btn'}
              onClick={() => setShowSettings((value) => !value)}
              aria-expanded={showSettings}
              aria-controls="mobile-viewer-settings"
              title="Viewer settings: facet planes, directions, wireframe, quality, screenshot"
              aria-label="Viewer settings"
            >
              ⚙
            </button>
          </div>
        ) : (
          <>
        <div className="toolbar-group">
          <button
            className={view.cameraMode === 'perspective' ? 'chip active' : 'chip'}
            onClick={() => onView({ cameraMode: 'perspective' })}
            title="Perspective camera"
          >
            Perspective
          </button>
          <button
            className={view.cameraMode === 'orthographic' ? 'chip active' : 'chip'}
            onClick={() => onView({ cameraMode: 'orthographic' })}
            title="Orthographic camera — no perspective distortion"
          >
            Orthographic
          </button>
        </div>
        <div className="toolbar-group">
          <button
            className="chip"
            onClick={() => setResetToken((token) => token + 1)}
            title="Reset the camera"
          >
            Reset view
          </button>
          <button className="chip" onClick={downloadPng} title="Save the current view as PNG">
            Screenshot PNG
          </button>
          <button
            className={fullscreen.isFullscreen ? 'chip active' : 'chip'}
            onClick={() => {
              void fullscreen.toggle()
            }}
            title={
              fullscreen.supported
                ? 'Fill the whole screen with the viewer (Esc leaves fullscreen)'
                : 'Fullscreen is not available in this browser'
            }
            data-testid="fullscreen-toggle"
          >
            {fullscreen.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        </div>
        <div className="toolbar-group">
          <button
            className={view.showFacetPlanes ? 'chip active' : 'chip'}
            onClick={() => onView({ showFacetPlanes: !view.showFacetPlanes })}
            title="Transparent facet planes with Miller-index labels"
          >
            Facet planes
          </button>
          <button
            className={view.showDirections ? 'chip active' : 'chip'}
            onClick={() => onView({ showDirections: !view.showDirections })}
            title="Crystallographic directions"
          >
            Directions
          </button>
          <button
            className={view.showWireframe ? 'chip active' : 'chip'}
            onClick={() => onView({ showWireframe: !view.showWireframe })}
            title="Ideal polyhedron wireframe"
          >
            Wireframe
          </button>
        </div>
        <div className="toolbar-group">
          {(['low', 'medium', 'high'] as const).map((quality) => (
            <button
              key={quality}
              className={view.quality === quality ? 'chip active' : 'chip'}
              onClick={() => onView({ quality })}
              title={`Sphere tessellation: ${quality}`}
            >
              {quality}
            </button>
          ))}
          </div>
          </>
        )}
      </div>

      {result && (
        <div className={isMobile ? 'viewer-hud compact' : 'viewer-hud'}>
          {isMobile ? (
            <span>
              <b>{renderData.counts.rendered.toLocaleString()}</b> atoms · {result.computeMs.toFixed(1)} ms
            </span>
          ) : (
            <>
              <span>
                <b>{renderData.counts.rendered.toLocaleString()}</b> / {renderData.counts.total.toLocaleString()} atoms drawn
                {renderData.counts.hidden > 0 ? ` (${renderData.counts.hidden.toLocaleString()} hidden)` : ''}
              </span>
              <span>sphere radius {sphereRadius.toFixed(2)} Å (visual only)</span>
              <span>computed locally in {result.computeMs.toFixed(1)} ms</span>
            </>
          )}
        </div>
      )}

      {fullscreen.isFullscreen && (
        <div className="viewer-hint">Esc 또는 Exit fullscreen 버튼으로 나가기</div>
      )}
      {fullscreen.message && (
        <div className="viewer-message" role="status" onClick={fullscreen.dismiss} title="Dismiss">
          {fullscreen.message}
        </div>
      )}
      {computing && <div className="computing">computing…</div>}
      {/* Desktop keeps the in-canvas legend; mobile never draws a panel over the model. */}
      {!isMobile && <ColorLegend view={view} result={result} />}
      </div>

      {isMobile && (showSettings || showLegend) && (
        <div
          className={panelsFloat ? 'viewer-side-panel float' : 'viewer-side-panel'}
          data-testid="mobile-panels"
        >
          {showLegend && (
            <section id="mobile-cn-legend" className="side-panel-section" aria-label="Coordination-number legend">
              <div className="side-panel-head">
                <span>CN Legend · 배위수 범례</span>
                <button className="chip tiny" onClick={() => setShowLegend(false)} aria-label="Close the legend">
                  ✕
                </button>
              </div>
              <ColorLegend view={view} result={result} />
            </section>
          )}
          {showSettings && (
            <section id="mobile-viewer-settings" className="side-panel-section" aria-label="Viewer settings">
              <div className="side-panel-head">
                <span>Viewer settings · 뷰어 설정</span>
                <button className="chip tiny" onClick={() => setShowSettings(false)} aria-label="Close the settings">
                  ✕
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">Projection</span>
                <button
                  className={view.cameraMode === 'perspective' ? 'chip touch active' : 'chip touch'}
                  onClick={() => onView({ cameraMode: 'perspective' })}
                >
                  Perspective
                </button>
                <button
                  className={view.cameraMode === 'orthographic' ? 'chip touch active' : 'chip touch'}
                  onClick={() => onView({ cameraMode: 'orthographic' })}
                >
                  Orthographic
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">Overlays</span>
                <button
                  className={view.showFacetPlanes ? 'chip touch active' : 'chip touch'}
                  onClick={() => onView({ showFacetPlanes: !view.showFacetPlanes })}
                >
                  Facet planes
                </button>
                <button
                  className={view.showDirections ? 'chip touch active' : 'chip touch'}
                  onClick={() => onView({ showDirections: !view.showDirections })}
                >
                  Directions
                </button>
                <button
                  className={view.showWireframe ? 'chip touch active' : 'chip touch'}
                  onClick={() => onView({ showWireframe: !view.showWireframe })}
                >
                  Wireframe
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">Quality</span>
                {(['low', 'medium', 'high'] as const).map((quality) => (
                  <button
                    key={quality}
                    className={view.quality === quality ? 'chip touch active' : 'chip touch'}
                    onClick={() => onView({ quality })}
                  >
                    {quality}
                  </button>
                ))}
              </div>
              <div className="settings-row">
                <span className="settings-label">Export</span>
                <button className="chip touch" onClick={downloadPng}>
                  Screenshot PNG
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </>
  )
}
