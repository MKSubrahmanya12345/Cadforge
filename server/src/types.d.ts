/**
 * Ambient declarations for dependencies that ship no types.
 */

declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }

  type PdfParseFn = (buffer: Buffer | Uint8Array) => Promise<PdfParseResult>;

  const pdfParse: PdfParseFn;
  export default pdfParse;
}

declare module 'occt-import-js' {
  export interface OcctFileResult {
    success: boolean;
    root: unknown;
    meshes: Array<{ name: string; color: [number, number, number, number]; attributes: { position: { array: Float32Array; itemSize: number }; normal?: { array: Float32Array; itemSize: number }; index?: { array: Uint32Array } } }>;
  }

  export interface OcctResult {
    ReadFile: (url: string, params?: unknown) => Promise<OcctFileResult>;
  }

  export interface InitOptions {
    locateFile?: (path: string, prefix?: string) => string;
  }

  export default function init(moduleOverrides?: InitOptions): Promise<OcctResult>;
}
