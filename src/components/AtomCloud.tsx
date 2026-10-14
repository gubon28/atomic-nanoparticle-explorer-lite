import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { RenderData } from '../colors'

interface AtomCloudProps {
  data: RenderData
  /** visual sphere radius in Angstrom (never changes an atomic coordinate) */
  radius: number
  segments: number
}

/**
 * One InstancedMesh = one draw call for the whole particle.
 *
 * The instance matrices carry only the sphere size and the position that was
 * computed by the local engine, so switching colour modes or the visual radius
 * never touches the atomic coordinates.
 */
export default function AtomCloud({ data, radius, segments }: AtomCloudProps) {
  const capacity = Math.max(data.counts.total, 1)
  const rings = Math.max(6, Math.round(segments / 2))
  const geometry = useMemo(() => new THREE.SphereGeometry(1, segments, rings), [segments, rings])
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        roughness: 0.42,
        metalness: 0.25,
        vertexColors: false,
      }),
    [],
  )
  const mesh = useMemo(() => {
    const instance = new THREE.InstancedMesh(geometry, material, capacity)
    instance.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    return instance
  }, [geometry, material, capacity])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
      mesh.dispose()
    },
    [geometry, material, mesh],
  )

  const lastData = useRef<RenderData | null>(null)
  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4()
    const colour = new THREE.Color()
    const count = Math.min(data.visibleCount, capacity)
    for (let i = 0; i < count; i += 1) {
      matrix.makeScale(radius, radius, radius)
      matrix.setPosition(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2])
      mesh.setMatrixAt(i, matrix)
      colour.setRGB(data.colors[i * 3], data.colors[i * 3 + 1], data.colors[i * 3 + 2], THREE.SRGBColorSpace)
      mesh.setColorAt(i, colour)
    }
    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor.needsUpdate = true
    }
    mesh.computeBoundingSphere()
    lastData.current = data
  }, [data, mesh, radius, capacity])

  return <primitive object={mesh} />
}
