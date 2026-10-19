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
}
