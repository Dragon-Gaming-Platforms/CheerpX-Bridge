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
  /** IndexedDB-backed writable block store (persistent overlay layer). */
  IDBDevice: { create(name: string): Promise<CheerpXDevice> };
  /** Writable overlay: reads fall through to base, writes go to overlay. */
  OverlayDevice: {
    create(base: CheerpXDevice, overlay: CheerpXDevice): Promise<CheerpXDevice>;
  };
}
