import { CHEERPX_VERSION, DISK, PROTOCOL_VERSION } from "./config";
import type { HosterState } from "./hoster";

/**
 * Tiny human-visible status view for the engine page (and debug page).
 * Humans opening the hoster URL directly should immediately see whether
 * the engine is healthy; the OS never reads this.
 */

const STATE_LABEL: Record<HosterState, string> = {
  idle: "idle",
  "waiting-for-isolation":
    "waiting for cross-origin isolation (service worker installing — page will reload itself once)",
  "loading-runtime": "loading CheerpX runtime…",
  creating: "creating VM (disk + mounts)…",
  "starting-shell": "starting /bin/bash…",
  running: "running (/bin/bash)",
  exited: "shell exited",
  failed: "FAILED",
};

export class StatusView {
  private engineText = STATE_LABEL.idle;
  private peerText =
    window.parent === window
      ? "not embedded (opened directly)"
      : "embedded — waiting for OS hello…";

  constructor(private readonly el: HTMLElement) {
    this.render();
  }

  setEngineState(state: HosterState, detail?: string): void {
    this.engineText = STATE_LABEL[state] + (detail ? ` — ${detail}` : "");
    this.render();
  }

  setPeer(text: string): void {
    this.peerText = text;
    this.render();
  }

  private render(): void {
    const isolated = window.crossOriginIsolated === true;
    const sab = typeof SharedArrayBuffer !== "undefined";
    const rows: Array<[string, string]> = [
      ["Engine", this.engineText],
      ["Cross-origin isolated", isolated ? "yes ✓" : "no ✗"],
      ["SharedArrayBuffer", sab ? "available ✓" : "unavailable ✗"],
      ["Bridge protocol", `v${PROTOCOL_VERSION}`],
      ["CheerpX runtime", `${CHEERPX_VERSION} (Leaning Technologies CDN)`],
      ["Disk image", `${DISK.kind} · ${DISK.url}`],
      ["OS peer", this.peerText],
    ];

    const dl = document.createElement("dl");
    dl.className = "status";
    for (const [key, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    this.el.replaceChildren(dl);
  }
}
