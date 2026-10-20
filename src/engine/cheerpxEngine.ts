import {
  CHEERPX_RUNTIME_URL,
  DISK,
  FS_AGENT_INTERVAL_S,
  IDB_OVERLAY_NAME,
  INBOX_MOUNT_PATH,
  INITIAL_COLS,
  INITIAL_ROWS,
  READY_FALLBACK_MS,
  SHARED_AGENT_LOG_NAME,
  SHARED_IDB_NAME,
  SHARED_MANIFEST_NAME,
  SHARED_MOUNT_PATH,
  SHELL,
} from "../config";
import type {
  EngineAdapter,
  EngineEvents,
  SharedFolderHooks,
} from "./adapter";
import type {
  CheerpXDataDevice,
  CheerpXIDBDevice,
  CheerpXLinux,
  CheerpXModule,
} from "./cheerpx";
import agentSource from "./guestAgent.py?raw";

/**
 * CheerpX implementation of EngineAdapter.
 *
 * This is the ONLY file that knows about CheerpX. It:
 *  - loads the runtime from Leaning Technologies' CDN (never bundled),
 *  - builds the filesystem: read-only base image + persistent IDB overlay,
 *  - wires I/O through cx.setCustomConsole (no DOM terminal here — the
 *    OS owns rendering),
 *  - runs /bin/bash --login, mirroring the CheerpX quickstart / WebVM,
 *  - provides the "fs1" shared folder: an IDB dir mount at
 *    /home/user/shared (guest read-write, JS read-back via
 *    readFileAsBlob) plus a DataDevice inbox the guest agent drains —
 *    see SharedFolderHooks and guestAgent.py.
 */
export class CheerpXEngine implements EngineAdapter {
  private readonly encoder = new TextEncoder();
  private cx: CheerpXLinux | null = null;
  private sendKey: ((keyCode: number) => void) | null = null;
  private sharedDevice: CheerpXIDBDevice | null = null;
  private inboxDevice: CheerpXDataDevice | null = null;
  private cols = INITIAL_COLS;
  private rows = INITIAL_ROWS;
  private started = false;
  private shellDone = false;
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

  sharedFolder(): SharedFolderHooks {
    return {
      readSharedFile: async (relPath) => {
        if (this.sharedDevice === null) return null;
        try {
          const blob = await this.sharedDevice.readFileAsBlob(
            `/${relPath.replace(/^\/+/, "")}`,
          );
          if (blob === null) return null;
          return new Uint8Array(await blob.arrayBuffer());
        } catch {
          return null; // transient device errors look like "not there yet"
        }
      },
      stageInboxFile: async (name, data) => {
        if (this.inboxDevice === null) {
          throw new Error("shared-folder inbox unavailable (engine not up)");
        }
        await this.inboxDevice.writeFile(`/${name.replace(/^\/+/, "")}`, data);
      },
    };
  }

  /**
   * Write the guest agent into the inbox and launch it as a background
   * process next to the interactive shell. The agent's first act is to
   * redirect its stdio to a log file in the shared folder, so it never
   * touches the console the user is typing on. Failure here must never
   * block the terminal: shared-folder sync just stays unconfirmed (and
   * the "fs1" capability is never advertised).
   */
  private async startAgent(cx: CheerpXLinux): Promise<void> {
    if (this.inboxDevice === null) return;
    try {
      await this.inboxDevice.writeFile("/agent.py", renderAgentSource());
    } catch (err) {
      console.warn("[dragon86-hoster] could not stage fs agent:", err);
      return;
    }
    const run = async (attempt: number): Promise<void> => {
      try {
        const { status } = await cx.run(
          "/usr/bin/python3",
          ["-u", `${INBOX_MOUNT_PATH}/agent.py`],
          {
            env: ["PATH=/usr/bin:/bin", "HOME=/home/user"],
            cwd: "/home/user",
            uid: SHELL.uid,
            gid: SHELL.gid,
          },
        );
        console.warn(
          `[dragon86-hoster] shared-folder agent exited (status ${status}, attempt ${attempt})`,
        );
      } catch (err) {
        console.warn("[dragon86-hoster] shared-folder agent failed:", err);
      }
      if (!this.shellDone && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (!this.shellDone) return run(attempt + 1);
      }
    };
    void run(1);
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
      // fs1 shared folder devices (see SharedFolderHooks): a persistent
      // dir-mounted IDBDevice the guest owns, and an in-memory DataDevice
      // "inbox" only JS writes (agent script + staged OS files + plans).
      this.sharedDevice = await CheerpX.IDBDevice.create(SHARED_IDB_NAME);
      this.inboxDevice = await CheerpX.DataDevice.create();

      const cx = await CheerpX.Linux.create({
        mounts: [
          { type: "ext2", path: "/", dev: overlayDevice },
          { type: "devs", path: "/dev" },
          { type: "devpts", path: "/dev/pts" },
          { type: "proc", path: "/proc" },
          { type: "sys", path: "/sys" },
          { type: "dir", path: SHARED_MOUNT_PATH, dev: this.sharedDevice },
          { type: "dir", path: INBOX_MOUNT_PATH, dev: this.inboxDevice },
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

      // Fire bash first, then the fs agent alongside it. (If cx.run ever
      // serialized processes, bash — called first — would still start and
      // only the agent would queue; the terminal must never be held
      // hostage by the shared-folder machinery.)
      const bashDone = cx.run(SHELL.file, [...SHELL.args], {
        env: [...SHELL.env],
        cwd: SHELL.cwd,
        uid: SHELL.uid,
        gid: SHELL.gid,
      });
      await this.startAgent(cx);

      const { status } = await bashDone;
      this.shellDone = true;

      const code = normalizeExitCode(status);
      this.events.onState("exited", `code ${code}`);
      this.events.onExit(code);
    } catch (err) {
      this.shellDone = true; // stop any agent restart attempts
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

/** Fill the guest agent's __TOKEN__s from config (single source of truth). */
function renderAgentSource(): string {
  return agentSource
    .replaceAll("__SHARED_DIR__", SHARED_MOUNT_PATH)
    .replaceAll("__INBOX_DIR__", INBOX_MOUNT_PATH)
    .replaceAll("__MANIFEST_NAME__", SHARED_MANIFEST_NAME)
    .replaceAll("__LOG_NAME__", SHARED_AGENT_LOG_NAME)
    .replaceAll("__INTERVAL_S__", String(FS_AGENT_INTERVAL_S));
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
