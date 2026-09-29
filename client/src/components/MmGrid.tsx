import { useMemo } from 'react';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';

/**
 * A millimetre grid with automatic level-of-detail.
 *
 * Three grids, each fading in as the camera approaches its spacing, so the
 * viewport reads as an engineering drawing at any zoom: fine lines close up,
 * coarse lines far away, and never 1 mm squares smeared across the whole screen
 * from 500 mm away.
 */
/**
 * Three grids at 1 mm, 10 mm, and 100 mm, each fading out as the camera pulls
 * away. drei's Grid already applies the fade; the ranges are sized so a
 * board-sized part (tens of mm) reads against the 1 mm and 10 mm grids, and the
 * 100 mm grid keeps the horizon meaningful when zoomed out.
 */
export function MmGrid({ visible }: { visible: boolean }): JSX.Element | null {
  if (!visible) return null;

  return (
    <group name="mm-grid">
      <Grid
        position={[0, 0, -0.05]}
        args={[400, 400]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#2a323d"
        sectionSize={5}
        sectionThickness={0.6}
        sectionColor="#39424f"
        fadeDistance={150}
        fadeStrength={1.6}
        infiniteGrid={false}
      />
      <Grid
        position={[0, 0, -0.04]}
        args={[1200, 1200]}
        cellSize={10}
        cellThickness={0.6}
        cellColor="#39424f"
        sectionSize={50}
        sectionThickness={0.8}
        sectionColor="#4a5462"
        fadeDistance={700}
        fadeStrength={1.4}
        infiniteGrid={false}
      />
      <Grid
        position={[0, 0, -0.03]}
        args={[5000, 5000]}
        cellSize={100}
        cellThickness={0.8}
        cellColor="#4a5462"
        sectionSize={500}
        sectionThickness={1}
        sectionColor="#5c6875"
        fadeDistance={3000}
        fadeStrength={1.2}
        infiniteGrid={false}
      />
    </group>
  );
}

/** A flat, subtly reflective ground plane so the model does not float in void. */
export function GroundPlane({ visible }: { visible: boolean }): JSX.Element | null {
  if (!visible) return null;
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, -0.08]}
      receiveShadow
      name="ground"
    >
      <planeGeometry args={[4000, 4000]} />
      <meshStandardMaterial color="#0d1116" roughness={0.95} metalness={0} />
    </mesh>
  );
}

export const AXIS_LENGTH = 20;

/** A small axis gizmo in world space, so +Z is unmistakably up. */
export function AxisGizmo({
  size = 3.2,
  position = [0, 0, 0] as [number, number, number],
}: {
  size?: number;
  position?: [number, number, number];
}): JSX.Element {
  const axes = useMemo<Array<{ dir: [number, number, number]; color: string; label: string }>>(
    () => [
      { dir: [1, 0, 0], color: '#ef476f', label: 'X' },
      { dir: [0, 1, 0], color: '#3ddc97', label: 'Y' },
      { dir: [0, 0, 1], color: '#4da3ff', label: 'Z' },
    ],
    [],
  );

  return (
    <group scale={[size, size, size]} position={position} name="axis-gizmo">
      {axes.map((axis) => {
        const quaternion = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(...axis.dir),
        );
        return (
          <group key={axis.label} quaternion={quaternion} name={`axis-${axis.label}`}>
            <mesh position={[0, 0.5, 0]}>
              <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
              <meshStandardMaterial
                color={axis.color}
                emissive={axis.color}
                emissiveIntensity={0.6}
                depthTest={false}
              />
            </mesh>
            <mesh position={[0, 1.06, 0]}>
              <coneGeometry args={[0.12, 0.24, 8]} />
              <meshStandardMaterial
                color={axis.color}
                emissive={axis.color}
                emissiveIntensity={0.6}
                depthTest={false}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
