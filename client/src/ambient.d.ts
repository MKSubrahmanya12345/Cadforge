/// <reference types="vite/client" />

/**
 * Vite resolves a `?url` import to a string at build time. This declaration
 * tells TypeScript the same, so `occt-import-js/dist/*.wasm?url` typechecks.
 */
declare module '*?url' {
  const url: string;
  export default url;
}

/**
 * occt-import-js ships no type declarations. Only `src/loaders/step.ts` consumes
 * it, and it re-declares the shape it needs, but the bare import still has to
 * resolve to *something* — this is that something.
 */
declare module 'occt-import-js' {
  interface OcctAttributes {
    position: { array: Float32Array; itemSize: number };
    normal?: { array: Float32Array; itemSize: number };
    index?: { array: Uint32Array };
  }

  interface OcctMesh {
    name: string;
    color: [number, number, number, number];
    attributes: OcctAttributes;
  }

  interface OcctResult {
    ReadFile: (
      url: string,
      params?: { linearUnit?: string },
    ) => Promise<{ success: boolean; root: unknown; meshes: OcctMesh[] }>;
  }

  interface InitOptions {
    locateFile?: (path: string, prefix?: string) => string;
  }

  const init: (overrides?: InitOptions) => Promise<OcctResult>;
  export default init;
}
