import {
  BACKLOG_MAX_BYTES,
  BROADCAST_CHANNEL_NAME,
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_BYTES,
  PROTOCOL_VERSION,
} from "../config";
import {
  isOriginAllowed,
  parseIncomingMessage,
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
}

/**
 * How protocol messages get to and from the OS. Two implementations:
 * PostMessageTransport (index.html, the real hidden-iframe deployment) and
 * LoopbackTransport (debug.html, engine on the same page).
 */
export interface BridgeTransport {
  send(msg: OutgoingMessage): void;
  onMessage(handler: (msg: IncomingMessage) => void): void;
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
    this.transport.send({ v: PROTOCOL_VERSION, t: "ready" });
    this.hooks.onPeerReady?.();
    if (firstAnnouncement) this.flush(); // replay backlog (first prompt)
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
  private peerOrigin: string | null = null;
  private readonly warnedOrigins = new Set<string>();

  constructor(private readonly onPeerOrigin?: (origin: string) => void) {
    window.addEventListener("message", (ev) => this.onWindowMessage(ev));
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  send(msg: OutgoingMessage): void {
    // We never speak first: the peer's origin is learned from its hello.
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
 * validator and a JSON round-trip (standing in for structured clone), so
 * the debug page exercises the same code path as production.
 */
export class LoopbackTransport implements BridgeTransport {
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private peerHandler: ((msg: OutgoingMessage) => void) | null = null;

  /** Hoster → fake OS. */
  send(msg: OutgoingMessage): void {
    const clone = JSON.parse(JSON.stringify(msg)) as OutgoingMessage;
    this.peerHandler?.(clone);
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  /** Fake-OS side: receive messages from the hoster. */
  onPeerMessage(handler: (msg: OutgoingMessage) => void): void {
    this.peerHandler = handler;
  }

  /** Fake-OS side: send a protocol message to the hoster. */
  sendToHoster(raw: unknown): void {
    const clone = JSON.parse(JSON.stringify(raw)) as unknown;
    const msg = parseIncomingMessage(clone);
    if (msg !== null) this.handler?.(msg);
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

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  private onChannelMessage(ev: MessageEvent): void {
    if (isHosterChannelMessage(ev.data)) return;
    const msg = parseIncomingMessage(ev.data);
    if (msg === null) return;
    if (msg.t === "hello") this.onHello?.();
    this.handler?.(msg);
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

  onMessage(handler: (msg: IncomingMessage) => void): void {
    for (const transport of this.transports) transport.onMessage(handler);
  }
}
