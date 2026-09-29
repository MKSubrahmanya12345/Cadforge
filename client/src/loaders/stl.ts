/**
 * STL loading via three's STLLoader, plus a tolerance-checked binary reader.
 *
 * three's loader has no binary/ascii switch that also reports units, and STL
 * carries no unit metadata at all. CADForge always writes millimetres, so the
 * geometry is taken as-is; the reader below exists so the UI can report the
 * triangle count and detect a file that is suspiciously large, which is the
 * signature of a 1000x scale bug.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export interface StlLoadResult {
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  /** True when the model is implausibly big, i.e. probably 1000x out. */
  suspiciouslyLarge: boolean;
}

/** A real assembly from this app is tens to hundreds of mm. 10 m is not. */
const PLAUSIBLE_MAX_MM = 10_000;

export async function loadStl(url: string): Promise<StlLoadResult> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not fetch the STL file (HTTP ${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();

  const count = geometry.getAttribute('position').count / 3;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3();
  const maxDim = Math.max(size.x, size.y, size.z);

  return {
    geometry,
    triangleCount: count,
    suspiciouslyLarge: maxDim > PLAUSIBLE_MAX_MM,
  };
}
