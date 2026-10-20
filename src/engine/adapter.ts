/**
 * Engine adapter contract.
 *
 * The bridge and pages talk only to this interface. CheerpX specifics live
 * in cheerpxEngine.ts — if the CheerpX API surface changes (or the engine
 * is ever swapped), that file is the only one that changes.
 */

export type EngineState =
  | "idle"
  | "loading-runtime" // fetching the engine runtime
  | "creating" // building devices / creating the VM instance
  | "starting-shell" // VM up, shell process launching
  | "running" // shell booted and streaming
  | "exited" // shell process terminated
  | "failed"; // boot failed (see detail)

export interface EngineEvents {
  /**
   * Raw stdout bytes from the shell. The array is owned by the receiver:
   * the adapter must already have copied it out of any engine-internal
   * (e.g. WASM) memory before calling this.
   */
  onOutput(bytes: Uint8Array): void;
  /** The shell is booted and streaming — the bridge may announce `ready`. */
  onReady(): void;
  /** The shell process exited with this code. */
  onExit(code: number): void;
  /** Lifecycle updates for the human-visible status line. */
  onState(state: EngineState, detail?: string): void;
}

export interface EngineAdapter {
  /** Begin booting. Progress and results arrive via EngineEvents. */
  start(): void;
  /** Send user input (keystrokes) to the shell's stdin. */
  write(data: string): void;
  /** Set the PTY/console size so full-screen apps redraw correctly. */
  resize(cols: number, rows: number): void;
  /**
   * Hooks for the guest-visible shared folder (protocol "fs1"), or null
   * if this engine can't provide one. The folder itself is created as
   * part of boot; the hooks are safe to call before boot completes
   * (reads resolve null, writes reject).
   */
  sharedFolder(): SharedFolderHooks | null;
}

/**
 * The two device primitives the shared-folder sync is built from — the
 * exact shape CheerpX's public device APIs allow (see the OS spec,
 * docs/cheerpx-fs-protocol.md, "Option A"):
 *
 *  - the shared folder itself is guest-read-write; JS can only READ
 *    files back out of it, one whole file at a time, with no listing
 *    (a guest-side agent publishes the listing as a manifest file), and
 *  - a separate "inbox" area JS can WRITE files into for the guest to
 *    read (the agent applies them into the shared folder from inside).
 *
 * Paths are relative to the respective root, "/"-separated, no leading
 * slash. Inbox names written through stageInboxFile are flat (no "/").
 */
export interface SharedFolderHooks {
  /** Read a whole file from the shared folder. Null = missing/unreadable. */
  readSharedFile(relPath: string): Promise<Uint8Array | null>;
  /** Write a whole file into the guest-readable inbox. */
  stageInboxFile(name: string, data: Uint8Array | string): Promise<void>;
}
