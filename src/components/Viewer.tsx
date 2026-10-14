import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import AtomCloud from './AtomCloud'
import FacetOverlay from './FacetOverlay'
import ShapeOutline from './ShapeOutline'
import DirectionAxes from './DirectionAxes'
import ColorLegend from './ColorLegend'
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

/** Frame the particle (size = circumscribed diameter in Angstrom). */
function CameraRig({ size, cameraMode, resetToken }: { size: number; cameraMode: ViewState['cameraMode']; resetToken: number }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3; update?: () => void } | null
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  const fit = Math.max(size * 1.6, 1)

  useEffect(() => {
    const distance = fit * 1.15
    const direction = new THREE.Vector3(0.62, 0.48, 0.82).normalize()
    camera.position.copy(direction.multiplyScalar(distance))
    camera.near = Math.max(0.05, distance / 800)
    camera.far = distance * 60
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera
      ortho.zoom = Math.min(width, height) / (fit * 1.05)
    }
    camera.updateProjectionMatrix()
    if (controls?.target) {
      controls.target.set(0, 0, 0)
      controls.update?.()
    }
  }, [camera, controls, fit, cameraMode, resetToken, width, height])

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
  const [resetToken, setResetToken] = useState(0)

  const size = result ? result.shape.maxExtentA : 40
  const segments = view.quality === 'low' ? 8 : view.quality === 'medium' ? 14 : renderData.counts.total > 8000 ? 12 : 20

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
    <div className="viewer" ref={wrapperRef}>
      <Canvas
        flat
        dpr={[1, 2]}
        gl={{ preserveDrawingBuffer: true, antialias: true, alpha: false }}
        style={{ background: 'radial-gradient(circle at 50% 35%, #16202e 0%, #0a0e14 72%)' }}
      >
        <hemisphereLight intensity={0.85} groundColor="#16202e" color="#dce6f5" />
        <directionalLight position={[1, 1.4, 0.9]} intensity={1.5} />
        <directionalLight position={[-1.2, -0.6, -1]} intensity={0.5} color="#9fc2ff" />

        {view.cameraMode === 'perspective' ? (
          <PerspectiveCamera makeDefault fov={38} near={0.1} far={4000} />
        ) : (
          <OrthographicCamera makeDefault near={0.1} far={4000} zoom={40} />
        )}
        <CameraRig size={size} cameraMode={view.cameraMode} resetToken={resetToken} />

        {result && renderData.visibleCount > 0 && (
          <AtomCloud data={renderData} radius={sphereRadius} segments={segments} />
        )}

        {result && view.showWireframe && <ShapeOutline facets={result.shape.facets} />}
        {result && view.showFacetPlanes && <FacetOverlay facets={result.shape.facets} />}
        {result && view.showDirections && <DirectionAxes length={size * 0.6} />}

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          rotateSpeed={0.85}
          zoomSpeed={0.9}
          panSpeed={0.8}
          minDistance={size * 0.3}
          maxDistance={size * 9}
        />
        <CaptureBridge captureRef={captureRef} />
      </Canvas>

      <div className="viewer-toolbar">
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
          <button className="chip" onClick={() => setResetToken((t) => t + 1)} title="Reset the camera">
            Reset view
          </button>
          <button className="chip" onClick={downloadPng} title="Save the current view as PNG">
            Screenshot PNG
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
      </div>

      {result && (
        <div className="viewer-hud">
          <span>
            <b>{renderData.counts.rendered.toLocaleString()}</b> / {renderData.counts.total.toLocaleString()} atoms drawn
            {renderData.counts.hidden > 0 ? ` (${renderData.counts.hidden.toLocaleString()} hidden)` : ''}
          </span>
          <span>sphere radius {sphereRadius.toFixed(2)} Å (visual only)</span>
          <span>
            computed locally in {result.computeMs.toFixed(1)} ms
          </span>
        </div>
      )}

      {computing && <div className="computing">computing…</div>}
      <ColorLegend view={view} result={result} />
    </div>
  )
}
