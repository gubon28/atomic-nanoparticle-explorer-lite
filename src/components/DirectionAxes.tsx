import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

const AXES: Array<{ label: string; vector: [number, number, number]; color: string; length: number }> = [
  { label: '[100]', vector: [1, 0, 0], color: '#4FC3F7', length: 1 },
  { label: '[010]', vector: [0, 1, 0], color: '#4FC3F7', length: 1 },
  { label: '[001]', vector: [0, 0, 1], color: '#4FC3F7', length: 1 },
  { label: '[110]', vector: [1, 1, 0], color: '#FFB74D', length: 0.92 },
  { label: '[111]', vector: [1, 1, 1], color: '#81C784', length: 0.86 },
]

/** Crystallographic direction indicators. */
export default function DirectionAxes({ length }: { length: number }) {
  const segments = useMemo(
    () =>
      AXES.map((axis) => {
        const dir = new THREE.Vector3(...axis.vector).normalize().multiplyScalar(length * axis.length)
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir])
        return { ...axis, geometry, tip: [dir.x, dir.y, dir.z] as [number, number, number] }
      }),
    [length],
  )

  return (
    <group>
      {segments.map((segment) => (
        <group key={segment.label}>
          <lineSegments geometry={segment.geometry}>
            <lineBasicMaterial color={segment.color} transparent opacity={0.9} />
          </lineSegments>
          <Html position={segment.tip} center zIndexRange={[5, 0]}>
            <div className="axis-label" style={{ color: segment.color }}>
              {segment.label}
            </div>
          </Html>
        </group>
      ))}
    </group>
  )
}
