import {
  ALLOWED_PARENT_ORIGINS,
  ALLOW_LOCALHOST_PARENTS,
  PROTOCOL_VERSION,
} from "../config";

/**
 * Bridge protocol v1 — the contract with the Dragon86 OS.
 * MUST stay behavior-identical to `src/bridge/hoster.ts` in
 * github.com/Dragon-Gaming-Platforms/Dragon86.
 *
 *   OS  → hoster : { v:1, t:"hello" }                 repeated ~400ms until answered
 *   hoster → OS  : { v:1, t:"ready" }                 only when isolated AND bash streaming
 *   OS  → hoster : { v:1, t:"data",   d:string }      keystrokes → PTY stdin
 *   hoster → OS  : { v:1, t:"data",   d:string }      PTY stdout → terminal
 *   OS  → hoster : { v:1, t:"resize", cols, rows }    terminal size → PTY winsize
 *   hoster → OS  : { v:1, t:"exit",   code }          shell exited
 *
 * This module is engine-free on purpose: if the CheerpX API changes, only
 * the engine adapter changes — never the protocol.
 */

export interface HelloMessage {
  v: typeof PROTOCOL_VERSION;
  t: "hello";
}

export interface ReadyMessage {
  v: typeof PROTOCOL_VERSION;
  t: "ready";
}

export interface DataMessage {
  v: typeof PROTOCOL_VERSION;
  t: "data";
  d: string;
}

export interface ResizeMessage {
  v: typeof PROTOCOL_VERSION;
  t: "resize";
  cols: number;
  rows: number;
}

export interface ExitMessage {
  v: typeof PROTOCOL_VERSION;
  t: "exit";
  code: number;
}

/** Messages the hoster accepts from the OS. */
export type IncomingMessage = HelloMessage | DataMessage | ResizeMessage;

/** Messages the hoster sends to the OS. */
export type OutgoingMessage = ReadyMessage | DataMessage | ExitMessage;

/** Sane terminal-size bounds; anything outside is clamped, not trusted. */
const MAX_COLS = 2000;
const MAX_ROWS = 1000;

function clampDimension(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/**
 * Validate and normalize an untrusted inbound payload. Returns null for
 * anything that is not a well-formed v1 message. Unknown message types
 * are rejected here so a future OS can't silently confuse this hoster.
 */
export function parseIncomingMessage(raw: unknown): IncomingMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.v !== PROTOCOL_VERSION) return null;

  switch (msg.t) {
    case "hello":
      return { v: PROTOCOL_VERSION, t: "hello" };
    case "data":
      if (typeof msg.d !== "string") return null;
      return { v: PROTOCOL_VERSION, t: "data", d: msg.d };
    case "resize": {
      const cols = clampDimension(msg.cols, MAX_COLS);
      const rows = clampDimension(msg.rows, MAX_ROWS);
      if (cols === null || rows === null) return null;
      return { v: PROTOCOL_VERSION, t: "resize", cols, rows };
    }
    default:
      return null;
  }
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Origin allowlist for the embedding parent:
 *  - this page's own origin (production: the OS lives on the same
 *    *.github.io origin; also covers our same-site embed-test page),
 *  - the Dragon86 GitHub Pages origin,
 *  - any localhost / 127.0.0.1 port, for OS development.
 */
export function isOriginAllowed(origin: string): boolean {
  if (origin === window.location.origin) return true;
  if (ALLOWED_PARENT_ORIGINS.includes(origin)) return true;
  if (ALLOW_LOCALHOST_PARENTS && LOCALHOST_ORIGIN.test(origin)) return true;
  return false;
}
