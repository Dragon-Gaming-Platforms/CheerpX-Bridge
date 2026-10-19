import { HosterBridge, type BridgeTransport } from "./bridge/hosterBridge";
import type { EngineState } from "./engine/adapter";
import { CheerpXEngine } from "./engine/cheerpxEngine";

/** Engine states plus the pre-boot "service worker hasn't isolated us yet" wait. */
export type HosterState = EngineState | "waiting-for-isolation";

export interface HosterHooks {
  onState?: (state: HosterState, detail?: string) => void;
  onPeerReady?: () => void;
  onExit?: (code: number) => void;
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
 */
export function startHoster(
  transport: BridgeTransport,
  hooks: HosterHooks = {},
): { bridge: HosterBridge; engine: CheerpXEngine } {
  let bridge: HosterBridge;
  const engine = new CheerpXEngine({
    onOutput: (bytes) => bridge.acceptOutput(bytes),
    onReady: () => bridge.markEngineReady(),
    onExit: (code) => {
      bridge.acceptExit(code);
      hooks.onExit?.(code);
    },
    onState: (state, detail) => hooks.onState?.(state, detail),
  });
  bridge = new HosterBridge(transport, engine, {
    onPeerReady: hooks.onPeerReady,
  });

  if (window.crossOriginIsolated) {
    engine.start();
  } else {
    hooks.onState?.("waiting-for-isolation");
  }
  return { bridge, engine };
}
