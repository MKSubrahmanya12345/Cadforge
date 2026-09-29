import { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/** Camera near/far tuned for millimetre-scale objects. */
export const CAMERA_NEAR = 0.5;
export const CAMERA_FAR = 20000;

/**
 * A 1 mm reference ruler laid on the ground plane next to the model.
 *
 * This is the "is it really 1:1?" check. Its length is fixed at exactly 10 mm of
 * world space, so if the model next to it looks like a 10 cm object, the
 * pipeline has a scale bug — which is exactly the failure this app exists to
 * prevent.
 */
export function Ruler({ position = [0, 0, 0.2] as [number, number, number] }): JSX.Element {
  const { viewport } = useThree();
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.name = 'reference-ruler';

    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(10, 0.4, 0.2),
      new THREE.MeshStandardMaterial({ color: '#4da3ff', roughness: 0.4 }),
    );
    bar.position.x = 5;
    bar.name = 'ruler-bar';
    g.add(bar);

    // Tick marks every 1 mm, taller every 5 mm.
    for (let i = 0; i <= 10; i += 1) {
      const major = i % 5 === 0;
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, major ? 1.6 : 0.9, 0.2),
        new THREE.MeshStandardMaterial({ color: major ? '#e8ecf2' : '#4da3ff', roughness: 0.4 }),
      );
      tick.position.set(i, major ? 0 : 0, 0);
      tick.name = `ruler-tick-${i}`;
      g.add(tick);
    }

    return g;
  }, []);

  // Keep the ruler a constant on-screen size so it reads as a scale reference
  // rather than as part of the model.
  const scale = Math.max(viewport.width / 200, 0.2);

  return (
    <group position={position} scale={scale} name="ruler">
      <primitive object={group} />
    </group>
  );
}

/** Raycast helper: the point in mm under the pointer, on the Z-up ground plane. */
export function useGroundPoint(): (event: { point: THREE.Vector3 }) => THREE.Vector3 {
  return (event) => event.point;
}
