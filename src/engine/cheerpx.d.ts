/**
 * Minimal hand-written typings for the slice of the CheerpX API this
 * project uses. The runtime itself is proprietary and loaded from
 * Leaning Technologies' CDN at runtime — it is never bundled — so there
 * are no types to import. Keep this in sync with cheerpx.io/docs if the
 * API calls below ever change.
 */

/** Opaque block/file device handle. */
export interface CheerpXDevice {
  readonly __cheerpxDevice?: unique symbol;
}

/** In-memory dir device: JS writes files in, the guest reads them. */
export interface CheerpXDataDevice extends CheerpXDevice {
  writeFile(name: string, contents: string | Uint8Array): Promise<void>;
}

/** IndexedDB-backed device (block overlay layer, or dir-mounted FS). */
export interface CheerpXIDBDevice extends CheerpXDevice {
  /** Read a whole file back out (dir-mounted use). Null = no such file. */
  readFileAsBlob(name: string): Promise<Blob | null>;
}

export interface CheerpXMountPoint {
  type: "ext2" | "dir" | "devs" | "devpts" | "proc" | "sys";
  path: string;
  dev?: CheerpXDevice;
}

export interface CheerpXRunOptions {
  env?: string[];
  cwd?: string;
  uid?: number;
  gid?: number;
}

export interface CheerpXLinux {
  /**
   * Wire a custom console: `writeFunc` receives output bytes, the returned
   * function feeds input one byte (key code) at a time. There is no
   * dedicated resize API — calling this again with new cols/rows resizes
   * the console/TTY.
   */
  setCustomConsole(
    writeFunc: (buf: Uint8Array, vt: number) => void,
    cols: number,
    rows: number,
  ): (keyCode: number) => void;

  /** Run a process; resolves with its exit status when it terminates. */
  run(
    fileName: string,
    args: string[],
    options?: CheerpXRunOptions,
  ): Promise<{ status: number }>;
}

export interface CheerpXModule {
  Linux: {
    create(options: { mounts: CheerpXMountPoint[] }): Promise<CheerpXLinux>;
  };
  /** Streams a hosted disk image over wss (read-only base). */
  CloudDevice: { create(url: string): Promise<CheerpXDevice> };
  /** Loads a disk image over HTTP range requests (read-only base). */
  HttpBytesDevice: { create(url: string): Promise<CheerpXDevice> };
  /** In-memory dir device JS can write files into. */
  DataDevice: { create(): Promise<CheerpXDataDevice> };
  /** IndexedDB-backed writable store (block overlay layer or dir FS). */
  IDBDevice: { create(name: string): Promise<CheerpXIDBDevice> };
  /** Writable overlay: reads fall through to base, writes go to overlay. */
  OverlayDevice: {
    create(base: CheerpXDevice, overlay: CheerpXDevice): Promise<CheerpXDevice>;
  };
}
