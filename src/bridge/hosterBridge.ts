import {
  BACKLOG_MAX_BYTES,
  BROADCAST_CHANNEL_NAME,
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_BYTES,
  PROTOCOL_VERSION,
} from "../config";
import {
  FS_PROTOCOL_VERSION,
  isOriginAllowed,
  parseFsResponse,
  parseIncomingMessage,
  type FsRequestMessage,
  type FsResponseMessage,
  type IncomingMessage,
  type OutgoingMessage,
} from "./protocol";

/**
 * The engine side of the bridge, as seen by the transport layer. The real
 * implementation is the CheerpX adapter; the bridge knows nothing about it.
 */
export interface BridgeEngine {
  /** Keystrokes from the OS → PTY stdin. */
  write(data: string): void;
  /** Terminal resize from the OS → PTY winsize. */
  resize(cols: number, rows: number): void;
}

/** Optional lifecycle hooks (used by the status line; not part of the wire protocol). */
export interface BridgeHooks {
  /** A peer said hello and `ready` has been (re-)announced. */
  onPeerReady?: () => void;
  /** The peer's advertised capability list changed (from hello caps). */
  onPeerCaps?: (caps: string[]) => void;
  /**
   * Capabilities this hoster can currently confirm live. Consulted at
   * every `ready` announcement; the ready carries the intersection with
   * the peer's hello caps (and no caps field at all when empty, keeping
   * the v1 wire byte-identical for peers that never asked).
   */
  getReadyCaps?: () => string[];
}

/**
 * How protocol messages get to and from the OS. Implementations:
 * PostMessageTransport (hidden iframe), BroadcastChannelTransport
 * (separate tab), CompositeTransport (fan-out over both), and
 * LoopbackTransport (debug.html, engine on the same page).
 *
 * The fs pair carries protocol-v2 shared-folder traffic, where the
 * hoster is the client (fs-req out, fs-res in) — opposite direction to
 * the v1 handshake. Transports route inbound traffic to exactly one of
 * the two handlers based on the message version.
 */
export interface BridgeTransport {
  send(msg: OutgoingMessage): void;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendFs(msg: FsRequestMessage): void;
  onFsMessage(handler: (msg: FsResponseMessage) => void): void;
}

/**
 * Hoster side of bridge protocol v1.
 *
 * Responsibilities:
 *  - Handshake: send `ready` ONLY once the engine reports the shell is
 *    booted and streaming, and only to a peer that said `hello`. If the
 *    engine never comes up we stay silent — the OS times out and reports
 *    "not connected", which is the specified failure mode.
 *  - Coalescing: engine output arrives as raw byte chunks (often a few
 *    bytes at a time); it is buffered and flushed as one `data` message
 *    per ~16ms window, decoded with a streaming UTF-8 decoder so a
 *    multi-byte character split across chunks never becomes "�".
 *  - Backlog: output produced before the handshake (typically the first
 *    bash prompt) is held and flushed right after `ready`, so the OS
 *    terminal never opens on a blank screen waiting for a keypress.
 */
export class HosterBridge {
  private readonly decoder = new TextDecoder("utf-8");
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: number | null = null;

  private engineReady = false;
  private peerSeen = false;
  private peerCaps = new Set<string>();
  private announcedReady = false;
  private lastReadyAt = 0;
  private exited = false;

  constructor(
    private readonly transport: BridgeTransport,
    private readonly engine: BridgeEngine,
    private readonly hooks: BridgeHooks = {},
  ) {
    transport.onMessage((msg) => this.handle(msg));
  }

  /** Engine → bridge: raw stdout bytes (caller guarantees ownership). */
  acceptOutput(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.exited) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;

    if (!this.announcedReady) {
      // Pre-handshake backlog: keep only the most recent bytes.
      while (this.pendingBytes > BACKLOG_MAX_BYTES && this.pending.length > 1) {
        this.pendingBytes -= this.pending.shift()!.length;
      }
      return;
    }
    if (this.pendingBytes >= FLUSH_MAX_BYTES) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Engine → bridge: the shell is booted and streaming. */
  markEngineReady(): void {
    if (this.engineReady) return;
    this.engineReady = true;
    this.maybeAnnounceReady();
  }

  /** Engine → bridge: the shell process exited. */
  acceptExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    if (!this.announcedReady) {
      // Died before the handshake completed: stay silent, per protocol.
      // The OS will time out and show "not connected".
      return;
    }
    // Any final output must reach the terminal before the exit notice.
    this.flush(/* final */ true);
    this.transport.send({ v: PROTOCOL_VERSION, t: "exit", code });
  }

  private handle(msg: IncomingMessage): void {
    switch (msg.t) {
      case "hello":
        this.peerSeen = true;
        this.notePeerCaps(msg.caps ?? []);
        this.maybeAnnounceReady();
        break;
      case "data":
        if (!this.exited) this.engine.write(msg.d);
        break;
      case "resize":
        if (!this.exited) this.engine.resize(msg.cols, msg.rows);
        break;
    }
  }

  private maybeAnnounceReady(): void {
    if (!this.engineReady || !this.peerSeen || this.exited) return;
    // The OS repeats hello every ~400ms until it sees ready; a couple of
    // hellos may already be in flight when our first ready lands. Answer
    // them (harmless), but don't re-announce faster than the hello cadence.
    const now = performance.now();
    if (this.announcedReady && now - this.lastReadyAt < 300) return;
    const firstAnnouncement = !this.announcedReady;
    this.announcedReady = true;
    this.lastReadyAt = now;
    this.sendReady();
    this.hooks.onPeerReady?.();
    if (firstAnnouncement) this.flush(); // replay backlog (first prompt)
  }

  /**
   * Re-send `ready` because the live capability set changed (e.g. the
   * shared folder finished its first sync after the terminal already
   * connected). The OS stops hello-ing after the first ready, so without
   * this nudge it would never learn late-arriving caps. No-op until the
   * first announcement has happened.
   */
  refreshReady(): void {
    if (!this.announcedReady || this.exited) return;
    this.lastReadyAt = performance.now();
    this.sendReady();
    this.hooks.onPeerReady?.();
  }

  private sendReady(): void {
    const live = this.hooks.getReadyCaps?.() ?? [];
    const caps = live.filter((cap) => this.peerCaps.has(cap));
    this.transport.send(
      caps.length > 0
        ? { v: PROTOCOL_VERSION, t: "ready", caps }
        : { v: PROTOCOL_VERSION, t: "ready" },
    );
  }

  private notePeerCaps(caps: string[]): void {
    const next = new Set(caps);
    const changed =
      next.size !== this.peerCaps.size ||
      [...next].some((cap) => !this.peerCaps.has(cap));
    this.peerCaps = next;
    if (changed) this.hooks.onPeerCaps?.([...next]);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private flush(final = false): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0 && !final) return;

    let text = "";
    for (const chunk of this.pending) {
      // stream:true holds a trailing partial UTF-8 sequence for next time.
      text += this.decoder.decode(chunk, { stream: true });
    }
    this.pending = [];
    this.pendingBytes = 0;
    if (final) text += this.decoder.decode(); // flush any partial sequence

    if (text.length > 0 && this.announcedReady) {
      this.transport.send({ v: PROTOCOL_VERSION, t: "data", d: text });
    }
  }
}

/**
 * Production transport: window.postMessage with the embedding parent.
 *
 * Security: every inbound message must come from our direct parent frame
 * AND from an allowlisted origin; outbound messages are addressed to the
 * exact origin that hello'd us — never "*".
 *
 * Diagnostics: a `hello` rejected purely for its origin logs ONE console
 * warning per origin (see warnRejectedHello). The protocol itself stays
 * silent toward untrusted origins, exactly as specified — the warning
 * only exists so "engine never connects" is diagnosable in devtools
 * instead of being a silent timeout on the OS side.
 */
export class PostMessageTransport implements BridgeTransport {
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private fsHandler: ((msg: FsResponseMessage) => void) | null = null;
  private peerOrigin: string | null = null;
  private readonly warnedOrigins = new Set<string>();

  constructor(private readonly onPeerOrigin?: (origin: string) => void) {
    window.addEventListener("message", (ev) => this.onWindowMessage(ev));
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  onFsMessage(handler: (msg: FsResponseMessage) => void): void {
    this.fsHandler = handler;
  }

  send(msg: OutgoingMessage): void {
    // We never speak first: the peer's origin is learned from its hello.
    if (this.peerOrigin === null || window.parent === window) return;
    window.parent.postMessage(msg, this.peerOrigin);
  }

  sendFs(msg: FsRequestMessage): void {
    if (this.peerOrigin === null || window.parent === window) return;
    window.parent.postMessage(msg, this.peerOrigin);
  }

  private onWindowMessage(ev: MessageEvent): void {
    if (window.parent === window) return; // not embedded
    if (ev.source !== window.parent) return; // only our direct parent
    if (!isOriginAllowed(ev.origin)) {
      this.warnRejectedHello(ev);
      return;
    }
    // Protocol-v2 fs responses take the fs handler; everything else must
    // be a well-formed v1 message. Same source+origin gates for both.
    if ((ev.data as { v?: unknown } | null)?.v === FS_PROTOCOL_VERSION) {
      const fsMsg = parseFsResponse(ev.data);
      if (fsMsg !== null) this.fsHandler?.(fsMsg);
      return;
    }
    const msg = parseIncomingMessage(ev.data);
    if (msg === null) return;
    if (this.peerOrigin === null) {
      this.peerOrigin = ev.origin;
      this.onPeerOrigin?.(ev.origin);
    }
    this.handler?.(msg);
  }

  /**
   * A parent is speaking our protocol from an origin we don't trust.
   * Warn once per origin — the OS repeats hello every ~400ms, so an
   * unthrottled warning would flood the console. Only hellos warn: they
   * are the handshake, and a rejected hello is precisely the "engine
   * never connects" symptom worth surfacing.
   */
  private warnRejectedHello(ev: MessageEvent): void {
    if (parseIncomingMessage(ev.data)?.t !== "hello") return;
    if (this.warnedOrigins.has(ev.origin)) return;
    this.warnedOrigins.add(ev.origin);
    console.warn(
      `[dragon86-hoster] Ignoring bridge hello from non-allowlisted parent ` +
        `origin "${ev.origin}". If this is the Dragon86 OS, add the origin ` +
        `to ALLOWED_PARENT_ORIGINS / ALLOWED_PARENT_ORIGIN_PATTERNS in ` +
        `src/config.ts. (This warning appears once per origin.)`,
    );
  }
}

/**
 * In-page transport for debug.html: the "OS" is a textarea console on the
 * same page as the engine. Messages still pass through the real protocol
 * validators and a structuredClone round-trip (same clone semantics as
 * postMessage/BroadcastChannel — notably Uint8Array payloads survive),
 * so the debug page exercises the same code path as production.
 */
export class LoopbackTransport implements BridgeTransport {
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private fsHandler: ((msg: FsResponseMessage) => void) | null = null;
  private peerHandler: ((msg: OutgoingMessage) => void) | null = null;
  private peerFsHandler: ((msg: FsRequestMessage) => void) | null = null;

  /** Hoster → fake OS. */
  send(msg: OutgoingMessage): void {
    this.peerHandler?.(structuredClone(msg));
  }

  sendFs(msg: FsRequestMessage): void {
    this.peerFsHandler?.(structuredClone(msg));
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  onFsMessage(handler: (msg: FsResponseMessage) => void): void {
    this.fsHandler = handler;
  }

  /** Fake-OS side: receive messages from the hoster. */
  onPeerMessage(handler: (msg: OutgoingMessage) => void): void {
    this.peerHandler = handler;
  }

  /** Fake-OS side: receive fs requests from the hoster. */
  onPeerFsMessage(handler: (msg: FsRequestMessage) => void): void {
    this.peerFsHandler = handler;
  }

  /** Fake-OS side: send a protocol message to the hoster. */
  sendToHoster(raw: unknown): void {
    const msg = parseIncomingMessage(structuredClone(raw));
    if (msg !== null) this.handler?.(msg);
  }

  /** Fake-OS side: answer an fs request. */
  sendFsToHoster(raw: unknown): void {
    const msg = parseFsResponse(structuredClone(raw));
    if (msg !== null) this.fsHandler?.(msg);
  }
}

/**
 * Marker stamped on every message THIS hoster posts on the
 * BroadcastChannel (extra field `via`). A channel delivers to every
 * same-name channel on the origin except the sending object — so a
 * *second* hoster tab would hear our stdout `data` messages, and `data`
 * is a valid inbound type: one engine's output would become the other's
 * stdin (feedback loop). Hosters therefore ignore channel traffic
 * carrying this marker. The OS ignores unknown fields, so this stays
 * backward compatible within protocol v1. It prevents hoster↔hoster
 * cross-talk only — two engines answering one OS at once is still
 * unsupported (see CompositeTransport); don't open two engine tabs.
 */
const BC_HOSTER_VIA = "bc-hoster";

function isHosterChannelMessage(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).via === BC_HOSTER_VIA
  );
}

let broadcastChannelWarned = false;

function createBroadcastChannel(name: string): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === "undefined") {
      throw new Error("BroadcastChannel unsupported");
    }
    return new BroadcastChannel(name);
  } catch {
    if (!broadcastChannelWarned) {
      broadcastChannelWarned = true;
      console.warn(
        `[dragon86-hoster] BroadcastChannel unavailable — "engine tab" ` +
          `mode disabled (embedded iframe mode is unaffected).`,
      );
    }
    return null;
  }
}

/**
 * Tab-mode transport: the OS opens this page as a separate top-level tab
 * and both sides speak bridge protocol v1 over a BroadcastChannel.
 * (window.opener is severed by this page's COOP, so direct postMessage
 * between the tabs is unavailable; BroadcastChannel is the side channel.)
 *
 * Trust boundary differs from PostMessageTransport: BroadcastChannel is
 * same-origin by platform construction, so there is no per-message origin
 * to allowlist — any page on this origin can post. Inbound traffic still
 * goes through the full protocol validator, and hoster-stamped traffic
 * (our own outbound, reflected via other tabs) is dropped up front.
 */
export class BroadcastChannelTransport implements BridgeTransport {
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private fsHandler: ((msg: FsResponseMessage) => void) | null = null;
  private readonly channel: BroadcastChannel | null;
  /** False when BroadcastChannel doesn't exist in this browser/context. */
  readonly available: boolean;

  constructor(
    channelName: string = BROADCAST_CHANNEL_NAME,
    private readonly onHello?: () => void,
  ) {
    this.channel = createBroadcastChannel(channelName);
    this.available = this.channel !== null;
    this.channel?.addEventListener("message", (ev) =>
      this.onChannelMessage(ev),
    );
  }

  send(msg: OutgoingMessage): void {
    this.channel?.postMessage({ ...msg, via: BC_HOSTER_VIA });
  }

  sendFs(msg: FsRequestMessage): void {
    this.channel?.postMessage({ ...msg, via: BC_HOSTER_VIA });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  onFsMessage(handler: (msg: FsResponseMessage) => void): void {
    this.fsHandler = handler;
  }

  private onChannelMessage(ev: MessageEvent): void {
    if (isHosterChannelMessage(ev.data)) return;
    const msg = parseIncomingMessage(ev.data);
    if (msg !== null) {
      if (msg.t === "hello") this.onHello?.();
      this.handler?.(msg);
      return;
    }
    // Not v1 — try protocol-v2 fs. (Another hoster tab's fs-req carries
    // the marker and was dropped above; an unmarked fs-req would fail
    // both parsers here, since we only ever consume fs-res.)
    const fsMsg = parseFsResponse(ev.data);
    if (fsMsg !== null) this.fsHandler?.(fsMsg);
  }
}

/**
 * Fan-out transport: ONE bridge (and one engine) behind several
 * transports. Outbound messages go to every transport; inbound messages
 * from any transport reach the single bridge handler. This is how the
 * engine page serves an embedded OS (postMessage) and a tab-mode OS
 * (BroadcastChannel) with one HosterBridge — two bridges on one engine
 * would double-announce and double-send engine output.
 *
 * Known v1 limitation (accepted): if an embedded peer AND a tab peer are
 * connected simultaneously, they share the single PTY — keystrokes merge
 * on stdin, output broadcasts to both, a resize from either resizes the
 * one console. The OS drives one mode at a time; demultiplexing peers
 * would need session IDs in a future protocol revision.
 */
export class CompositeTransport implements BridgeTransport {
  constructor(private readonly transports: readonly BridgeTransport[]) {}

  send(msg: OutgoingMessage): void {
    for (const transport of this.transports) transport.send(msg);
  }

  sendFs(msg: FsRequestMessage): void {
    for (const transport of this.transports) transport.sendFs(msg);
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    for (const transport of this.transports) transport.onMessage(handler);
  }

  onFsMessage(handler: (msg: FsResponseMessage) => void): void {
    for (const transport of this.transports) transport.onFsMessage(handler);
  }
}
