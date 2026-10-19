import {
  CHEERPX_RUNTIME_URL,
  DISK,
  IDB_OVERLAY_NAME,
  INITIAL_COLS,
  INITIAL_ROWS,
  READY_FALLBACK_MS,
  SHELL,
} from "../config";
import type { EngineAdapter, EngineEvents } from "./adapter";
import type { CheerpXLinux, CheerpXModule } from "./cheerpx";

/**
 * CheerpX implementation of EngineAdapter.
 *
 * This is the ONLY file that knows about CheerpX. It:
 *  - loads the runtime from Leaning Technologies' CDN (never bundled),
 *  - builds the filesystem: read-only base image + persistent IDB overlay,
 *  - wires I/O through cx.setCustomConsole (no DOM terminal here — the
 *    OS owns rendering),
 *  - runs /bin/bash --login, mirroring the CheerpX quickstart / WebVM.
 */
export class CheerpXEngine implements EngineAdapter {
  private readonly encoder = new TextEncoder();
  private cx: CheerpXLinux | null = null;
  private sendKey: ((keyCode: number) => void) | null = null;
  private cols = INITIAL_COLS;
  private rows = INITIAL_ROWS;
  private started = false;
  private readySignalled = false;
  private readyFallbackTimer: number | null = null;
  private resizeTimer: number | null = null;

  constructor(private readonly events: EngineEvents) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.boot();
  }

  write(data: string): void {
    if (this.sendKey === null) return;
    // setCustomConsole's input function takes one byte at a time. Encode
    // as UTF-8 (not charCodeAt — that would corrupt non-ASCII input).
    const bytes = this.encoder.encode(data);
    for (const byte of bytes) this.sendKey(byte);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.cx === null) return; // size is queued for the initial attach
    // Coalesce bursts (window drags) — apply the final size once.
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.attachConsole();
    }, 30);
  }

  private async boot(): Promise<void> {
    try {
      this.events.onState("loading-runtime");
      const CheerpX = (await import(
        /* @vite-ignore */ CHEERPX_RUNTIME_URL
      )) as unknown as CheerpXModule;

      this.events.onState("creating");
      const baseDevice =
        DISK.kind === "cloud"
          ? await CheerpX.CloudDevice.create(DISK.url)
          : await CheerpX.HttpBytesDevice.create(DISK.url);
      const idbDevice = await CheerpX.IDBDevice.create(IDB_OVERLAY_NAME);
      const overlayDevice = await CheerpX.OverlayDevice.create(
        baseDevice,
        idbDevice,
      );

      const cx = await CheerpX.Linux.create({
        mounts: [
          { type: "ext2", path: "/", dev: overlayDevice },
          { type: "devs", path: "/dev" },
          { type: "devpts", path: "/dev/pts" },
          { type: "proc", path: "/proc" },
          { type: "sys", path: "/sys" },
        ],
      });
      this.cx = cx;
      this.attachConsole();

      this.events.onState("starting-shell");
      // Safety net: ready normally fires on the first output byte (the
      // bash prompt). If a shell ever starts silently, don't hang forever.
      this.readyFallbackTimer = window.setTimeout(
        () => this.signalReady(),
        READY_FALLBACK_MS,
      );

      const { status } = await cx.run(SHELL.file, [...SHELL.args], {
        env: [...SHELL.env],
        cwd: SHELL.cwd,
        uid: SHELL.uid,
        gid: SHELL.gid,
      });

      const code = normalizeExitCode(status);
      this.events.onState("exited", `code ${code}`);
      this.events.onExit(code);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.events.onState("failed", detail);
      // If the shell had been announced ready, a crash is an exit as far
      // as the OS is concerned. Before ready, stay silent (OS times out).
      if (this.readySignalled) this.events.onExit(-1);
    } finally {
      if (this.readyFallbackTimer !== null) {
        window.clearTimeout(this.readyFallbackTimer);
        this.readyFallbackTimer = null;
      }
    }
  }

  private attachConsole(): void {
    if (this.cx === null) return;
    // (Re-)attach with the current size. CheerpX has no resize API:
    // calling setCustomConsole again with new cols/rows updates the TTY
    // size, which is what makes vim/top redraw on OS window resizes.
    this.sendKey = this.cx.setCustomConsole(
      (buf) => {
        // `buf` may be a view into WASM memory that the engine reuses —
        // copy it before handing it to the (async) bridge.
        this.events.onOutput(new Uint8Array(buf));
        this.signalReady();
      },
      this.cols,
      this.rows,
    );
  }

  private signalReady(): void {
    if (this.readySignalled) return;
    this.readySignalled = true;
    if (this.readyFallbackTimer !== null) {
      window.clearTimeout(this.readyFallbackTimer);
      this.readyFallbackTimer = null;
    }
    this.events.onState("running");
    this.events.onReady();
  }
}

/**
 * cx.run() resolves with the process status. That is normally the plain
 * exit code; if a build ever returns a raw waitpid-style status (exit
 * code in the high byte, signal in the low 7 bits), decode that too.
 */
function normalizeExitCode(status: unknown): number {
  if (typeof status !== "number" || !Number.isFinite(status)) return 0;
  if (status > 255 && (status & 0x7f) === 0) return (status >> 8) & 0xff;
  return Math.trunc(status);
}
