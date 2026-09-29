import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import {
  Bounds,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
  useGLTF,
} from '@react-three/drei';
import * as THREE from 'three';
import { api } from '../api';
import { usePipeline } from '../state/pipeline';
import { loadStep } from '../loaders/step';
import { loadStl } from '../loaders/stl';
import { AxisGizmo, GroundPlane, MmGrid } from './MmGrid';
import { Ruler } from './Ruler';
import type { Format } from '../types';
import './Viewport.css';

/** Camera clip planes for millimetre-scale objects. */
const CAMERA_NEAR = 0.5;
const CAMERA_FAR = 20000;
const DEFAULT_CAMERA: [number, number, number] = [90, -110, 70];

/** glTF is metres; the CAD world is millimetres. */
const GLTF_TO_MM = 1000;

type LoadedFormat = Format | 'none';

interface LoadedModel {
  format: Format;
  object: THREE.Object3D;
  triangles: number;
}

/**
 * Split a model into the parts that can be exploded.
 *
 * GLB exports one named node per part, which is exactly the granularity we want.
 * STEP and STL are a single mesh with no part identity, so they are treated as
 * one part and the explode slider does nothing rather than tearing a solid
 * apart.
 */
interface PartNode {
  name: string;
  object: THREE.Object3D;
  /** Unit vector from the assembly centre to this part's own centre. */
  direction: THREE.Vector3;
  radius: number;
}

function splitParts(root: THREE.Object3D): PartNode[] {
  const rootBox = new THREE.Box3().setFromObject(root);
  const rootCentre = rootBox.getCenter(new THREE.Vector3());
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const rootRadius = Math.max(rootSize.length() / 2, 1);

  const candidates: THREE.Object3D[] = [];
  for (const child of root.children) {
    const hasMesh = (() => {
      let found = false;
      child.traverse((n) => {
        if (n instanceof THREE.Mesh) found = true;
      });
      return found;
    })();
    if (hasMesh) candidates.push(child);
  }

  // A single mesh means no part identity: nothing to explode.
  if (candidates.length <= 1) {
    return [{ name: root.name || 'model', object: root, direction: new THREE.Vector3(), radius: rootRadius }];
  }

  return candidates.map((child) => {
    const box = new THREE.Box3().setFromObject(child);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const offset = centre.clone().sub(rootCentre);
    const direction = offset.lengthSq() > 1e-9 ? offset.clone().normalize() : new THREE.Vector3(0, 0, 1);
    return {
      name: child.name || 'part',
      object: child,
      direction,
      radius: Math.max(size.length() / 2, rootRadius * 0.1),
    };
  });
}

/** Applies the exploded-view offset to each part, in millimetres. */
function ExplodedParts({ root, explode }: { root: THREE.Object3D; explode: number }): null {
  useEffect(() => {
    if (explode <= 0) return;
    const parts = splitParts(root);
    for (const part of parts) {
      // 0..100 maps to 0..2x the part's own radius, which reads as "pulled
      // apart" without scattering a 68mm board across the viewport.
      const distance = (explode / 100) * part.radius * 2;
      part.object.position.copy(part.direction).multiplyScalar(distance);
    }
    return () => {
      for (const part of parts) {
        part.object.position.set(0, 0, 0);
      }
    };
  }, [root, explode]);
  return null;
}

/** Reports the clicked part's world-space bounding box. */
function usePartSelection(
  onSelect: (info: { name: string; size: THREE.Vector3 }) => void,
): (event: ThreeEvent<MouseEvent>) => void {
  return useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const target = event.object;
      if (!(target instanceof THREE.Mesh)) return;
      // Walk up to the top-level part node so the card names the part, not the
      // triangle that happened to be clicked.
      let node: THREE.Object3D = target;
      while (node.parent && node.parent.type !== 'Scene') {
        node = node.parent;
      }
      const box = new THREE.Box3().setFromObject(node);
      const size = box.getSize(new THREE.Vector3());
      onSelect({ name: node.name || 'part', size });
    },
    [onSelect],
  );
}

/** Makes every mesh in the tree clickable and reports which one was hit. */
function PartPicker({
  root,
  onSelect,
}: {
  root: THREE.Object3D;
  onSelect: (info: { name: string; size: THREE.Vector3 }) => void;
}): null {
  const handler = usePartSelection(onSelect);

  useEffect(() => {
    // three's typed event map has no "click", but react-three-fiber's event
    // layer dispatches DOM CustomEvents named after the event.
    type ClickTarget = THREE.Mesh & {
      addEventListener(type: string, listener: EventListener): void;
      removeEventListener(type: string, listener: EventListener): void;
    };

    const targets: ClickTarget[] = [];
    root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const target = child as ClickTarget;
        targets.push(target);
        target.addEventListener('click', handler as unknown as EventListener);
      }
    });
    return () => {
      for (const target of targets) {
        target.removeEventListener('click', handler as unknown as EventListener);
      }
    };
  }, [root, handler]);

  return null;
}

/**
 * Native GLB loading.
 *
 * glTF is metres and Y-up; CADForge works in millimetres and Z-up, so the scene
 * is scaled up by 1000 and rotated -90 degrees about X. Skip either and the
 * model is 1000x too small or lying on its side.
 */
function GlbModel({
  url,
  wireframe,
  onTriangles,
  onRoot,
}: {
  url: string;
  wireframe: boolean;
  onTriangles: (count: number) => void;
  onRoot: (root: THREE.Object3D | null) => void;
}): JSX.Element {
  const { scene } = useGLTF(url);
  const ref = useRef<THREE.Group>(null);

  const clone = useMemo(() => {
    const copy = scene.clone(true);
    copy.position.set(0, 0, 0);
    copy.rotation.set(0, 0, 0);
    copy.scale.set(GLTF_TO_MM, GLTF_TO_MM, GLTF_TO_MM);
    return copy;
  }, [scene]);

  useEffect(() => {
    const group = ref.current;
    if (!group) return;
    onRoot(group);
    return () => onRoot(null);
  }, [onRoot]);

  useEffect(() => {
    const group = ref.current;
    if (!group) return;

    let triangles = 0;
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const material = child.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(material) ? material : [material]) {
        applyMaterialFlags(m, wireframe);
      }
      const geometry = child.geometry as THREE.BufferGeometry;
      const index = geometry.getIndex();
      triangles += index ? index.count / 3 : geometry.getAttribute('position').count / 3;
    });
    onTriangles(triangles);
  }, [clone, wireframe, onTriangles]);

  return (
    <group ref={ref} name="glb-model" rotation={[-Math.PI / 2, 0, 0]}>
      <primitive object={clone} />
    </group>
  );
}

/** STEP and STL, which the native GLB path cannot read. */
function CadModel({ model, wireframe }: { model: LoadedModel; wireframe: boolean }): JSX.Element {
  const clone = useMemo(() => {
    const copy = model.object.clone(true);
    copy.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const material = child.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(material) ? material : [material]) {
        applyMaterialFlags(m, wireframe);
      }
    });
    return copy;
  }, [model.object, wireframe]);

  return <primitive object={clone} name={`${model.format}-model`} />;
}

/**
 * Renders nothing itself; it exists to run the explode and pick effects against
 * whichever model is currently loaded, from outside the Suspense boundary that
 * actually renders it.
 */
function ModelRoot(props: {
  modelRef: { current: THREE.Object3D | null };
  explode: number;
  onSelect: (info: { name: string; size: THREE.Vector3 }) => void;
}): JSX.Element {
  const root = props.modelRef.current;
  if (!root) return <></>;
  return (
    <>
      <ExplodedParts root={root} explode={props.explode} />
      <PartPicker root={root} onSelect={props.onSelect} />
    </>
  );
}

function MeasureOverlay({
  active,
  pointA,
  pointB,
  onGroundClick,
}: {
  active: boolean;
  pointA: THREE.Vector3 | null;
  pointB: THREE.Vector3 | null;
  onGroundClick: (point: THREE.Vector3) => void;
}): JSX.Element | null {
  if (!active) return null;
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onGroundClick(e.point);
        }}
        visible={false}
      >
        <planeGeometry args={[6000, 6000]} />
        <meshBasicMaterial side={THREE.DoubleSide} />
      </mesh>
      {pointA ? <Marker point={pointA} color="#4da3ff" /> : null}
      {pointB ? <Marker point={pointB} color="#3ddc97" /> : null}
      {pointA && pointB ? <MeasureLine between={[pointA, pointB]} /> : null}
    </group>
  );
}

function Marker({ point, color }: { point: THREE.Vector3; color: string }): JSX.Element {
  return (
    <mesh position={point}>
      <sphereGeometry args={[0.7, 12, 12]} />
      <meshBasicMaterial color={color} depthTest={false} />
    </mesh>
  );
}

function MeasureLine({ between }: { between: [THREE.Vector3, THREE.Vector3] }): JSX.Element {
  const geometry = useMemo(() => {
    const [a, b] = between;
    const direction = new THREE.Vector3().subVectors(b, a);
    const length = direction.length();
    if (length < 1e-6) return new THREE.BufferGeometry();
    const midpoint = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize(),
    );
    const g = new THREE.CylinderGeometry(0.12, 0.12, length, 8);
    g.applyQuaternion(quaternion);
    g.translate(midpoint.x, midpoint.y, midpoint.z);
    return g;
  }, [between]);

  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial color="#ffd166" depthTest={false} />
    </mesh>
  );
}

/**
 * CAD geometry is not reliably closed or correctly wound, so double-sided is the
 * safe default. Wireframe is a toggle rather than a separate material set, so
 * switching it never rebuilds the geometry.
 */
function applyMaterialFlags(material: THREE.Material, wireframe: boolean): void {
  material.side = THREE.DoubleSide;
  const withWireframe = material as THREE.Material & { wireframe?: boolean };
  withWireframe.wireframe = wireframe;
}

export function Viewport(): JSX.Element {
  const { project } = usePipeline();
  const [format, setFormat] = useState<LoadedFormat>('none');
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [cadRoot, setCadRoot] = useState<THREE.Object3D | null>(null);
  const [glbRoot, setGlbRoot] = useState<THREE.Object3D | null>(null);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<Format[]>([]);
  const [showFormats] = useState(true);

  const [grid, setGrid] = useState(true);
  const [gizmo, setGizmo] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [ruler, setRuler] = useState(true);
  const [ortho, setOrtho] = useState(false);
  const [realScale, setRealScale] = useState(false);
  const [explode, setExplode] = useState(0);
  const [measure, setMeasure] = useState(false);
  const [measureA, setMeasureA] = useState<THREE.Vector3 | null>(null);
  const [measureB, setMeasureB] = useState<THREE.Vector3 | null>(null);
  const [selected, setSelected] = useState<{ name: string; size: THREE.Vector3 } | null>(null);
  const [triangles, setTriangles] = useState(0);
  const [screenshotNote, setScreenshotNote] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);

  const projectId = project?._id ?? null;
  const status = project?.status ?? null;
  const running = status !== null && !['complete', 'failed'].includes(status);

  // Formats the server actually produced. FCStd is a CAD application format,
  // not a viewer format, so it is offered as a download but never as a view.
  useEffect(() => {
    if (!project?.artifacts) {
      setAvailable([]);
      setFormat('none');
      return;
    }
    const list = (['step', 'glb', 'stl', 'fcstd'] as const).filter(
      (f) => project.artifacts[f] !== null,
    );
    setAvailable(list);
    // GLB first: already coloured, already exploded into named part nodes.
    const viewable = list.filter((f) => f !== 'fcstd');
    setFormat(viewable.includes('glb') ? 'glb' : (viewable[0] ?? 'none'));
  }, [project?.artifacts]);

  const viewable = useMemo(
    () => available.filter((f): f is Format => f === 'glb' || f === 'step' || f === 'stl'),
    [available],
  );

  // Load STEP / STL outside the GLB path. A format that fails to load is
  // silently skipped (console only) rather than shown as an error, because the
  // downloads still work and the user did not ask for this format.
  useEffect(() => {
    if (!projectId || format === 'glb' || format === 'none' || format === 'fcstd') {
      setModel(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const url = api.fileUrl(projectId, format);

    const run = async (): Promise<void> => {
      try {
        if (format === 'step') {
          const result = await loadStep(url);
          if (cancelled) return;
          setModel({ format, object: result.group, triangles: result.triangleCount });
        } else {
          const result = await loadStl(url);
          if (cancelled) return;
          if (result.suspiciouslyLarge) {
            console.warn(
              `[CADForge] ${url} is implausibly large. This usually means the model was ` +
                'built in metres instead of millimetres.',
            );
          }
          const mesh = new THREE.Mesh(
            result.geometry,
            new THREE.MeshStandardMaterial({ color: '#8a8f98', metalness: 0.15, roughness: 0.55 }),
          );
          mesh.name = 'stl-model';
          setModel({ format, object: mesh, triangles: result.triangleCount });
        }
      } catch (err) {
        if (cancelled) return;
        console.warn(`[CADForge] could not load ${format}:`, err);
        setModel(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, format]);

  // Reset per-project view state.
  useEffect(() => {
    setMeasureA(null);
    setMeasureB(null);
    setSelected(null);
    setTriangles(0);
    setExplode(0);
  }, [projectId]);

  useEffect(() => {
    if (!measure) {
      setMeasureA(null);
      setMeasureB(null);
    }
  }, [measure]);

  const handleGroundClick = useCallback(
    (point: THREE.Vector3) => {
      if (!measure) return;
      if (!measureA) {
        setMeasureA(point.clone());
        setMeasureB(null);
      } else {
        setMeasureB(point.clone());
      }
    },
    [measure, measureA],
  );

  const measurement = useMemo(() => {
    if (!measureA || !measureB) return null;
    const d = new THREE.Vector3().subVectors(measureB, measureA);
    return {
      distance: d.length(),
      dx: Math.abs(d.x),
      dy: Math.abs(d.y),
      dz: Math.abs(d.z),
    };
  }, [measureA, measureB]);

  const takeScreenshot = (): void => {
    const canvas = document.querySelector('.viewport__canvas canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      setScreenshotNote('The 3D canvas is not ready yet.');
      return;
    }
    try {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `${projectId ?? 'cadforge'}-${format}.png`;
      link.click();
      setScreenshotNote(null);
    } catch {
      setScreenshotNote('The browser blocked the screenshot. Try a format download instead.');
    }
  };

  const hasModel = format === 'glb' || model !== null;
  const activeRoot = format === 'glb' ? glbRoot : cadRoot;
  const isEmpty = !projectId;

  return (
    <div className="viewport">
      <div className="viewport__canvas">
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          camera={{ fov: 35, near: CAMERA_NEAR, far: CAMERA_FAR, position: DEFAULT_CAMERA }}
          onPointerMissed={() => setSelected(null)}
        >
          <color attach="background" args={['#0a0c10']} />
          <ambientLight intensity={0.5} />
          <hemisphereLight args={['#8fb8ff', '#0a0c10', 0.35]} />
          <directionalLight
            position={[120, -80, 180]}
            intensity={1.6}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-near={1}
            shadow-camera-far={800}
            shadow-camera-left={-250}
            shadow-camera-right={250}
            shadow-camera-top={250}
            shadow-camera-bottom={-250}
          />
          <directionalLight position={[-140, 90, 60]} intensity={0.4} />

          <MmGrid visible={grid} />
          <GroundPlane visible={grid} />
          {ruler && hasModel ? <Ruler /> : null}
          {gizmo && hasModel ? <AxisGizmo size={7} position={[0, 0, 0]} /> : null}

          {/* Bounds wraps the model so `fit` measures the model, not the grid.
              In real-scale mode the camera is the reference, so the model is
              rendered outside and Bounds is not mounted at all. */}
          {realScale ? (
            <ModelStage
              format={format}
              projectId={projectId}
              model={model}
              wireframe={wireframe}
              onTriangles={setTriangles}
              onGlbRoot={setGlbRoot}
              onCadRoot={setCadRoot}
            />
          ) : (
            <Bounds fit clip observe margin={1.15} key={`${fitKey}-${format}-${ortho ? 'o' : 'p'}`}>
              <ModelStage
                format={format}
                projectId={projectId}
                model={model}
                wireframe={wireframe}
                onTriangles={setTriangles}
                onGlbRoot={setGlbRoot}
                onCadRoot={setCadRoot}
              />
            </Bounds>
          )}

          {activeRoot ? (
            <ModelRoot
              modelRef={{ current: activeRoot }}
              explode={explode}
              onSelect={setSelected}
            />
          ) : null}

          <MeasureOverlay
            active={measure}
            pointA={measureA}
            pointB={measureB}
            onGroundClick={handleGroundClick}
          />

          {ortho ? (
            <OrthographicCamera
              makeDefault
              position={DEFAULT_CAMERA}
              zoom={14}
              near={CAMERA_NEAR}
              far={CAMERA_FAR}
            />
          ) : (
            <PerspectiveCamera
              makeDefault
              fov={35}
              near={CAMERA_NEAR}
              far={CAMERA_FAR}
              position={DEFAULT_CAMERA}
            />
          )}

          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.12}
            minDistance={1}
            maxDistance={10000}
            target={[0, 0, 0]}
          />

        </Canvas>
      </div>

      <Toolbar
        format={format}
        onGrid={() => setGrid((v) => !v)}
        onGizmo={() => setGizmo((v) => !v)}
        grid={grid}
        gizmo={gizmo}
        wireframe={wireframe}
        onWireframe={() => setWireframe((v) => !v)}
        ruler={ruler}
        onRuler={() => setRuler((v) => !v)}
        ortho={ortho}
        onOrtho={() => setOrtho((v) => !v)}
        realScale={realScale}
        onRealScale={() => setRealScale((v) => !v)}
        measure={measure}
        onMeasure={() => setMeasure((v) => !v)}
        explode={explode}
        onExplode={setExplode}
        onScreenshot={takeScreenshot}
        onFit={() => {
          setRealScale(false);
          setFitKey((k) => k + 1);
        }}
        disabled={!hasModel}
      />

      {showFormats && viewable.length > 1 ? (
        <div className="format-tabs" role="tablist" aria-label="Model format">
          {viewable.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={f === format}
              className={`format-tab${f === format ? ' format-tab--active' : ''}`}
              onClick={() => setFormat(f)}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}

      <div className="viewport__badges">
        {hasModel ? (
          <>
            <span className="badge-info">
              {triangles > 0 ? `${triangles.toLocaleString()} tris · ` : ''}
              {format.toUpperCase()}
            </span>
            <span className="badge-info badge-info--accent">
              {format === 'glb' ? 'glTF: metres, Y-up' : 'CAD frame: mm, Z-up'}
            </span>
            {realScale ? <span className="badge-info badge-info--accent">real scale 1:1</span> : null}
          </>
        ) : null}
      </div>

      {measure ? (
        <div className={`measure-readout${measureA && !measureB ? ' measure-readout--armed' : ''}`}>
          {measurement ? (
            <>
              <div className="measure-readout__row">
                <span className="measure-readout__value">{measurement.distance.toFixed(3)} mm</span>
                <span>
                  Δx {measurement.dx.toFixed(2)} · Δy {measurement.dy.toFixed(2)} · Δz{' '}
                  {measurement.dz.toFixed(2)}
                </span>
              </div>
              <div className="measure-readout__hint">
                Click two more points to measure again.
              </div>
            </>
          ) : measureA ? (
            <span className="measure-readout__hint">
              First point at ({measureA.x.toFixed(2)}, {measureA.y.toFixed(2)},{' '}
              {measureA.z.toFixed(2)}) mm — click the second point.
            </span>
          ) : (
            <span className="measure-readout__hint">
              Click two points in the model to measure the distance in millimetres.
            </span>
          )}
        </div>
      ) : null}

      {selected && selected.size.length() > 0 ? (
        <div className="selection-card">
          <div className="selection-card__name" title={selected.name}>
            {selected.name}
          </div>
          <div className="selection-card__dims">
            <span className="selection-card__key">X</span>
            <span className="selection-card__value">{selected.size.x.toFixed(3)} mm</span>
            <span className="selection-card__key">Y</span>
            <span className="selection-card__value">{selected.size.y.toFixed(3)} mm</span>
            <span className="selection-card__key">Z</span>
            <span className="selection-card__value">{selected.size.z.toFixed(3)} mm</span>
            <span className="selection-card__key">diagonal</span>
            <span className="selection-card__value">
              {selected.size.length().toFixed(3)} mm
            </span>
          </div>
        </div>
      ) : null}

      <div className="viewport__bottom">
        <div className="viewport__downloads">
          {available.map((f) => (
            <a
              key={f}
              className="download-btn"
              href={projectId ? api.fileUrl(projectId, f) : '#'}
              download
              onClick={(e) => {
                if (!projectId) e.preventDefault();
              }}
            >
              ↓ {f.toUpperCase()}
            </a>
          ))}
          {screenshotNote ? <span className="badge-info">{screenshotNote}</span> : null}
        </div>
      </div>

      {isEmpty ? (
        <div className="viewport__overlay">
          <div className="viewport__empty-icon" aria-hidden>
            ◫
          </div>
          <div className="viewport__overlay-title">No model yet</div>
          <p className="viewport__overlay-text">
            Describe a part or assembly in the sidebar. CADForge researches real dimensions from
            datasheets, then generates a true-scale model you can measure in millimetres.
          </p>
        </div>
      ) : null}

      {!isEmpty && running ? (
        <div className="viewport__overlay">
          <span className="spinner" />
          <div className="viewport__overlay-title">Generating · {status}</div>
          <p className="viewport__overlay-text">
            The model appears when the export stage finishes. The pipeline log in the sidebar has the
            detail.
          </p>
        </div>
      ) : null}

      {!isEmpty && !running && !hasModel && !loading ? (
        <div className="viewport__overlay">
          <div className="viewport__empty-icon" aria-hidden>
            ⌀
          </div>
          <div className="viewport__overlay-title">
            {status === 'failed' ? 'The pipeline failed' : 'No viewable format'}
          </div>
          <p className="viewport__overlay-text">
            {status === 'failed'
              ? 'No model was exported. The sidebar log has the stage and message that failed.'
              : 'STEP, GLB, and STL could not be loaded in the browser. The downloads below still work.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whatever model is currently selected, in one place. Keeping this separate
 * means Bounds can wrap it in Fit mode and skip it entirely in Real-scale mode.
 */
function ModelStage({
  format,
  projectId,
  model,
  wireframe,
  onTriangles,
  onGlbRoot,
  onCadRoot,
}: {
  format: LoadedFormat;
  projectId: string | null;
  model: LoadedModel | null;
  wireframe: boolean;
  onTriangles: (count: number) => void;
  onGlbRoot: (root: THREE.Object3D | null) => void;
  onCadRoot: (root: THREE.Object3D | null) => void;
}): JSX.Element {
  return (
    <Suspense fallback={null}>
      {format === 'glb' && projectId ? (
        <GlbModel
          url={api.fileUrl(projectId, 'glb')}
          wireframe={wireframe}
          onTriangles={onTriangles}
          onRoot={onGlbRoot}
        />
      ) : null}
      {format !== 'glb' && model ? (
        <CadModelWithRoot model={model} wireframe={wireframe} onRoot={onCadRoot} />
      ) : null}
    </Suspense>
  );
}

function CadModelWithRoot({
  model,
  wireframe,
  onRoot,
}: {
  model: LoadedModel;
  wireframe: boolean;
  onRoot: (root: THREE.Object3D | null) => void;
}): JSX.Element {
  useEffect(() => {
    onRoot(model.object);
    return () => onRoot(null);
  }, [model, onRoot]);
  return <CadModel model={model} wireframe={wireframe} />;
}

interface ToolbarProps {
  format: LoadedFormat;
  grid: boolean;
  onGrid: () => void;
  gizmo: boolean;
  onGizmo: () => void;
  wireframe: boolean;
  onWireframe: () => void;
  ruler: boolean;
  onRuler: () => void;
  ortho: boolean;
  onOrtho: () => void;
  realScale: boolean;
  onRealScale: () => void;
  measure: boolean;
  onMeasure: () => void;
  explode: number;
  onExplode: (value: number) => void;
  onScreenshot: () => void;
  onFit: () => void;
  disabled: boolean;
}

function Toolbar(props: ToolbarProps): JSX.Element {
  const cls = (on: boolean): string => (on ? 'toolbar__btn toolbar__btn--on' : 'toolbar__btn');
  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <button
          type="button"
          className={cls(props.realScale)}
          onClick={props.onRealScale}
          title="Lock the camera at 1:1 so the model can be judged against the 10mm ruler"
        >
          Real scale
        </button>
        <button
          type="button"
          className="toolbar__btn"
          onClick={props.onFit}
          title="Fit the model to the viewport"
          disabled={props.disabled}
        >
          Fit
        </button>
        <span className="toolbar__sep" />
        <button
          type="button"
          className={cls(props.ortho)}
          onClick={props.onOrtho}
          title="Orthographic projection, for reading dimensions"
        >
          {props.ortho ? 'Ortho' : 'Persp'}
        </button>
        <button
          type="button"
          className={cls(props.wireframe)}
          onClick={props.onWireframe}
          title="Show edges only"
        >
          Wireframe
        </button>
        <span className="toolbar__sep" />
        <button type="button" className={cls(props.grid)} onClick={props.onGrid} title="Millimetre grid">
          Grid
        </button>
        <button type="button" className={cls(props.gizmo)} onClick={props.onGizmo} title="X/Y/Z gizmo">
          Axes
        </button>
        <button
          type="button"
          className={cls(props.ruler)}
          onClick={props.onRuler}
          title="10mm reference ruler"
        >
          Ruler
        </button>
        <button
          type="button"
          className={cls(props.measure)}
          onClick={props.onMeasure}
          title="Click two points to measure the distance in mm"
        >
          Measure
        </button>
      </div>

      <div className="toolbar__group">
        <div className="toolbar__slider">
          <span className="toolbar__label">Explode</span>
          <input
            type="range"
            min={0}
            max={100}
            value={props.explode}
            onChange={(e) => props.onExplode(Number(e.target.value))}
            aria-label="Exploded view amount"
          />
          <span className="toolbar__slider-value">{props.explode}%</span>
        </div>
        <span className="toolbar__sep" />
        <button
          type="button"
          className="toolbar__btn"
          onClick={props.onScreenshot}
          disabled={props.disabled}
          title="Save a PNG of the viewport"
        >
          Screenshot
        </button>
      </div>
    </div>
  );
}
