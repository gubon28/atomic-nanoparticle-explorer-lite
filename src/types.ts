/** Shared types for the Lite (browser-only) explorer. */

export type HKL = [number, number, number]
export type ElementSymbol = 'Au' | 'Ag' | 'Pt' | 'Pd' | 'Cu'
export type MorphologyId =
  | 'cube'
  | 'octahedron'
  | 'rhombic_dodecahedron'
  | 'truncated_octahedron'
  | 'cuboctahedron'
  | 'custom'

/** One half-space n . r <= distance (n = unit normal of the (hkl) plane). */
export interface Plane {
  index: number
  miller: HKL
  family: string
  normal: [number, number, number]
  distanceA: number
  weight: number
  spacingA: number
}

/** One planar facet of the convex body. */
export interface Facet {
  index: number
  planeIndex: number
  miller: HKL
  family: string
  normal: [number, number, number]
  distanceA: number
  areaA2: number
  verticesA: Array<[number, number, number]>
}

export interface ShapeResult {
  facets: Facet[]
  /** sum of the facet areas (Angstrom^2) */
  surfaceAreaA2: number
  /** exact volume of the convex body (Angstrom^3), = sum(area * d)/3 */
  volumeA3: number
  /** largest bounding-box extent of the ideal body (Angstrom) */
  maxExtentA: number
  /** bounding box of the ideal body */
  boundsA: { min: [number, number, number]; max: [number, number, number] }
  verticesA: Array<[number, number, number]>
}

export interface ElementInfo {
  symbol: ElementSymbol
  name: string
  atomicNumber: number
  latticeConstantA: number
  atomicMass: number
  metallicRadiusA: number
  densityGCm3: number
  color: string
  nearestNeighbourA: number
  surfaceDensity100: number
  surfaceDensity111: number
  surfaceDensity110: number
}

export interface MorphologyInfo {
  id: MorphologyId
  label: string
  facetLabel: string
  description: string
  /** relative plane distances d_hkl (dimensionless, scaled to the requested size) */
  weights: Record<string, number>
}

/** Request for one nanoparticle (mirrors the Full engine's core parameters). */
export interface LiteRequest {
  element: ElementSymbol
  morphology: MorphologyId
  diameterNm: number
  /** user-defined relative plane distances, used when morphology === 'custom' */
  customWeights?: Record<string, number> | null
  /** 'center' = atom centre inside the body (default); 'shell' also keeps the
   *  outer atomic shell that straddles the surface */
  boundaryInclusion: 'center' | 'shell'
  /** snap the global plane scale so the primary facet sits on a lattice plane */
  latticeAlign: boolean
}

export const CLASS_BULK = 0
export const CLASS_FACET = 1
export const CLASS_EDGE = 2
export const CLASS_CORNER = 3
export const CLASS_SURFACE_OTHER = 4

export interface AnalysisResult {
  nAtoms: number
  /** coordination number per atom (neighbours within 1.2 * a/sqrt(2)) */
  cn: Int8Array
  /** site class per atom (see CLASS_*) */
  siteClass: Int8Array
  /** index into planes for terrace atoms, -1 otherwise */
  facetPlaneIndex: Int32Array
  /** index into shape.facets for terrace atoms, -1 otherwise */
  facetId: Int32Array
  /** signed distance to the ideal surface (negative = inside) */
  distanceToSurfaceA: Float64Array
  surfaceAtoms: number
  bulkAtoms: number
  classCounts: Record<string, number>
  /** terrace atom count per plane family */
  terraceByFamily: Record<string, number>
  maxCn: number
}

export interface LiteResult {
  request: LiteRequest
  element: ElementInfo
  morphology: MorphologyInfo
  weights: Record<string, number>
  planes: Plane[]
  shape: ShapeResult
  /** atom centres in Angstrom, flat [x0,y0,z0, x1,...] (float64, exact lattice) */
  positionsA: Float64Array
  /** visual data derived from the positions (instance colours/attributes) */
  analysis: AnalysisResult
  cutoffA: number
  /** deterministic timing of the local computation (ms) */
  computeMs: number
  warnings: string[]
}

export type ColorMode = 'element' | 'coordination' | 'surface' | 'facet' | 'site_class'
export type CameraMode = 'perspective' | 'orthographic'

export interface ViewState {
  colorMode: ColorMode
  metalRadiusScale: number
  showBulk: boolean
  showFacetOnly: boolean
  cameraMode: CameraMode
  showFacetPlanes: boolean
  showDirections: boolean
  showWireframe: boolean
  quality: 'low' | 'medium' | 'high'
}
