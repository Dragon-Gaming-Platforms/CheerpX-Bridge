import { HosterBridge, type BridgeTransport } from "./bridge/hosterBridge";
import { FS_CAP } from "./config";
import type { EngineState } from "./engine/adapter";
import { CheerpXEngine } from "./engine/cheerpxEngine";
import { SharedFolderSync } from "./fs/sharedFolderSync";

/** Engine states plus the pre-boot "service worker hasn't isolated us yet" wait. */
export type HosterState = EngineState | "waiting-for-isolation";

export interface HosterHooks {
  onState?: (state: HosterState, detail?: string) => void;
  onPeerReady?: () => void;
  onExit?: (code: number) => void;
  /** Human-readable shared-folder sync state for the status page. */
  onSharedFolderState?: (text: string) => void;
}

/**
 * Wire a bridge transport to a fresh engine and start booting.
 * Shared by index.html (postMessage to the OS) and debug.html (loopback).
 *
 * If the page is not cross-origin isolated there is no SharedArrayBuffer
 * and CheerpX cannot run. On a first-ever load the coi service worker is
 * still installing and will reload the page as soon as it takes control;
 * the engine boots on that second load. Until then we simply don't start
 * (and never announce `ready` — the OS keeps hello-ing or times out,
 * exactly as the protocol specifies).
 *
 * Shared folder ("fs1"): when the engine provides folder hooks, a
 * SharedFolderSync runs alongside the terminal bridge over the same
 * transport. It only does work once the peer's hello advertises the
 * "fs1" capability, and the bridge only echoes "fs1" in `ready` once
 * sync reports itself live (guest agent manifest seen + first clean
 * cycle) — re-announcing ready if that happens after the terminal
 * already connected. In debug.html the loopback peer never advertises
 * fs1, so sync stays dormant (the guest agent still runs; inspect
 * ~/shared/.dragon86-manifest.json from the debug shell).
 */
export function startHoster(
  transport: BridgeTransport,
  hooks: HosterHooks = {},
): { bridge: HosterBridge; engine: CheerpXEngine } {
  let bridge: HosterBridge;
  let sync: SharedFolderSync | null = null;
  let peerWantsFs = false;

  const engine = new CheerpXEngine({
    onOutput: (bytes) => bridge.acceptOutput(bytes),
    onReady: () => {
      bridge.markEngineReady();
      if (peerWantsFs) sync?.start();
    },
    onExit: (code) => {
      sync?.stop();
      bridge.acceptExit(code);
      hooks.onExit?.(code);
    },
    onState: (state, detail) => {
      if (state === "failed") sync?.stop();
      hooks.onState?.(state, detail);
    },
  });

  const sharedFolder = engine.sharedFolder();
  if (sharedFolder !== null) {
    sync = new SharedFolderSync(transport, sharedFolder, {
      onStatus: (text) => hooks.onSharedFolderState?.(text),
      onLiveChange: (live) => {
        // The OS stops hello-ing after the first ready, so nudge it
        // when fs1 comes up late. (The protocol has no retraction; a
        // later false only affects future re-announces.)
        if (live) bridge.refreshReady();
      },
    });
  }

  bridge = new HosterBridge(transport, engine, {
    onPeerReady: hooks.onPeerReady,
    onPeerCaps: (caps) => {
      peerWantsFs = caps.includes(FS_CAP);
      sync?.setPeerCaps(caps);
      if (peerWantsFs) sync?.start();
    },
    getReadyCaps: () => (sync?.live ? [FS_CAP] : []),
  });

  if (window.crossOriginIsolated) {
    engine.start();
  } else {
    hooks.onState?.("waiting-for-isolation");
  }
  return { bridge, engine };
}
