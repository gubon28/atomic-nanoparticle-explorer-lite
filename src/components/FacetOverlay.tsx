import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { FAMILY_COLORS } from '../colors'
import type { Facet } from '../types'

/** Transparent facet planes with their Miller-index labels. */
export default function FacetOverlay({ facets, opacity = 0.16 }: { facets: ReadonlyArray<Facet>; opacity?: number }) {
  const meshes = useMemo(
    () =>
      facets.map((facet) => {
        const vertices = facet.verticesA
        const triangles: number[] = []
        for (let i = 1; i < vertices.length - 1; i += 1) {
          triangles.push(0, i, i + 1)
        }
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(vertices.flatMap((v) => [v[0], v[1], v[2]]), 3),
        )
        geometry.setIndex(triangles)
        geometry.computeVertexNormals()
        const centroid: [number, number, number] = [0, 0, 0]
        for (const v of vertices) {
          centroid[0] += v[0] / vertices.length
          centroid[1] += v[1] / vertices.length
          centroid[2] += v[2] / vertices.length
        }
        const normal: [number, number, number] = [
          centroid[0] * 0.06 + facet.distanceA * facet.normal[0],
          centroid[1] * 0.06 + facet.distanceA * facet.normal[1],
          centroid[2] * 0.06 + facet.distanceA * facet.normal[2],
        ]
        return { facet, geometry, labelPosition: normal }
      }),
    [facets],
  )

  return (
    <group>
      {meshes.map(({ facet, geometry, labelPosition }) => (
        <group key={facet.index}>
          <mesh geometry={geometry} renderOrder={2}>
            <meshBasicMaterial
              color={FAMILY_COLORS[facet.family] ?? '#4FC3F7'}
              transparent
              opacity={opacity}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <Html position={labelPosition} center zIndexRange={[10, 0]}>
            <div className="facet-label">
              {`{${facet.miller.join('')}}`.replace(/-/g, '')} · {facet.areaA2.toFixed(1)} Å²
            </div>
          </Html>
        </group>
      ))}
    </group>
  )
}
