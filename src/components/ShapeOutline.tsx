import { useMemo } from 'react'
import * as THREE from 'three'
import { FAMILY_COLORS } from '../colors'
import type { Facet } from '../types'

/** Facet edge wireframe of the ideal polyhedron (coloured per family). */
export default function ShapeOutline({ facets }: { facets: ReadonlyArray<Facet> }) {
  const lines = useMemo(() => {
    const byFamily = new Map<string, number[]>()
    for (const facet of facets) {
      const vertices = facet.verticesA
      const positions = byFamily.get(facet.family) ?? []
      for (let i = 0; i < vertices.length; i += 1) {
        const a = vertices[i]
        const b = vertices[(i + 1) % vertices.length]
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2])
      }
      byFamily.set(facet.family, positions)
    }
    return [...byFamily.entries()].map(([family, positions]) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      return { family, geometry }
    })
  }, [facets])

  return (
    <group>
      {lines.map(({ family, geometry }) => (
        <lineSegments key={family} geometry={geometry} renderOrder={3}>
          <lineBasicMaterial color={FAMILY_COLORS[family] ?? '#8AB4F8'} transparent opacity={0.85} />
        </lineSegments>
      ))}
    </group>
  )
}
