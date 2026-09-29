/**
 * occt-import-js is a WASM OpenCascade STEP reader — the browser equivalent of
 * the worker's CadQuery kernel.
 */
import * as THREE from 'three';
import { GLTF_SCALE, Y_UP_TO_Z_UP } from '@cadforge/shared';

type OcctAttributes = {
  position: { array: Float32Array; itemSize: number };
  normal?: { array: Float32Array; itemSize: number };
  index?: { array: Uint32Array };
};

type OcctResult = {
  ReadFile: (
    url: string,
    params?: { linearUnit?: string },
  ) => Promise<{ success: boolean; root: unknown; meshes: Array<{ name: string; color: [number, number, number, number]; attributes: OcctAttributes }> }>;
};

let occtPromise: Promise<OcctResult> | null = null;

/**
 * Instantiating the WASM module on demand.
 *
 * Both the JS glue and the ~7 MB binary are pulled in with a dynamic import the
 * first time someone opens the STEP tab, so a GLB-only session never downloads
 * an OpenCascade kernel it will not use.
 */
async function getOcct(): Promise<OcctResult> {
  occtPromise ??= (async () => {
    const [{ default: initOcct }, { default: wasmUrl }] = await Promise.all([
      import('occt-import-js'),
      import('occt-import-js/dist/occt-import-js.wasm?url'),
    ]);
    try {
      return await initOcct({ locateFile: () => wasmUrl });
    } catch (err) {
      // If the hashed asset cannot be served, fall back to a copy the user put
      // in client/public (SETUP.md step 5.3).
      console.warn('[CADForge] STEP loader falling back to /occt-import-js.wasm', err);
      return initOcct({ locateFile: () => '/occt-import-js.wasm' });
    }
  })();
  return occtPromise;
}

export interface StepLoadResult {
  group: THREE.Group;
  triangleCount: number;
}

/**
 * Load a STEP file and return a group in the same space as everything else:
 * millimetres, Z-up.
 *
 * occt-import-js reports Y-up (the glTF convention) and millimetres, so this
 * rotates back into the CAD frame rather than rotating the CAD frame into glTF.
 * The GLB export path does the opposite conversion at export time; this is the
 * inverse, which is why the two agree.
 */
export async function loadStep(url: string): Promise<StepLoadResult> {
  const occt = await getOcct();
  const result = await occt.ReadFile(url, { linearUnit: 'millimeter' });
  if (!result.success) {
    throw new Error('OpenCascade could not read this STEP file');
  }

  const group = new THREE.Group();
  group.name = 'step-root';

  let triangles = 0;
  for (const mesh of result.meshes) {
    const attrs: OcctAttributes | undefined = mesh.attributes;
    if (!attrs?.position) continue;
    const { array: position, itemSize } = attrs.position;
    const index = attrs.index?.array;
    const color = mesh.color;

    const positions: number[] = [];
    for (let i = 0; i < position.length; i += itemSize) {
      // (x, y, z) Y-up -> (x, z, -y) Z-up, the CAD frame.
      const x = position[i] ?? 0;
      const y = position[i + 1] ?? 0;
      const z = position[i + 2] ?? 0;
      positions.push(x, z, -y);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (index) {
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
      triangles += index.length / 3;
    }
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255),
      metalness: 0.15,
      roughness: 0.55,
      side: THREE.DoubleSide,
      transparent: color[3] < 255,
      opacity: color[3] / 255,
    });

    const part = new THREE.Mesh(geometry, material);
    part.name = mesh.name || 'step-part';
    group.add(part);
  }

  if (group.children.length === 0) {
    throw new Error('The STEP file contained no meshes');
  }

  // Y-up -> Z-up, so the viewer and the CAD worker cannot silently disagree.
  group.applyMatrix4(new THREE.Matrix4().fromArray([...Y_UP_TO_Z_UP.m]));
  // occt reported millimetres and CADForge writes millimetres, so no unit
  // scale is applied here. The GLB path applies GLTF_SCALE (0.001) instead.
  void GLTF_SCALE;

  return { group, triangleCount: triangles };
}

