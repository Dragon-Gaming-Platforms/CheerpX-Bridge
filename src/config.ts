/**
 * Central configuration for the Dragon86 hoster page.
 *
 * Everything tunable lives here — most importantly the CheerpX runtime URL,
 * which is intentionally a single constant: CheerpX is proprietary and is
 * loaded ONLY from Leaning Technologies' CDN under their Community License.
 * Never vendor, download or self-host the runtime/wasm files in this repo.
 * (If a future commercial license allows self-hosting, this is the one
 * place that changes.)
 */

/** Bridge protocol version — must match src/bridge/hoster.ts in the OS repo. */
export const PROTOCOL_VERSION = 1;

/** CheerpX runtime (proprietary, Community License). Loaded from CDN only. */
export const CHEERPX_VERSION = "1.2.8";
export const CHEERPX_RUNTIME_URL = `https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}/cx.esm.js`;

/**
 * Root filesystem source.
 *  - "cloud": Leaning Technologies' hosted Debian image (the one from the
 *    official CheerpX quickstart), streamed on demand via CloudDevice.
 *  - "http-bytes": a self-hosted ext2 image served next to this page,
 *    loaded via HttpBytesDevice — for future custom Dragon86 images.
 * Either way, an IDBDevice overlay on top makes writes persist in the
 * browser across reloads.
 */
export interface DiskConfig {
  kind: "cloud" | "http-bytes";
  url: string;
}

export const DISK: DiskConfig = {
  kind: "cloud",
  url: "wss://disks.webvm.io/debian_large_20230522_5044875331.ext2",
  // To use a custom image later, drop it in public/ and switch to:
  // kind: "http-bytes",
  // url: "./image.ext2",
};

/**
 * IndexedDB name for the writable overlay. Deliberately namespaced: every
 * project site under dragon-gaming-platforms.github.io shares ONE origin,
 * so the bare "block1" from the CheerpX examples could collide with
 * another app's overlay.
 */
export const IDB_OVERLAY_NAME = "dragon86-hoster-overlay-v1";

/** Shell to run — mirrors the CheerpX quickstart / WebVM. */
export const SHELL = {
  file: "/bin/bash",
  args: ["--login"],
  env: [
    "HOME=/home/user",
    "TERM=xterm",
    "USER=user",
    "SHELL=/bin/bash",
    "EDITOR=vim",
    "LANG=en_US.UTF-8",
    "LC_ALL=C",
  ],
  cwd: "/home/user",
  uid: 1000,
  gid: 1000,
} as const;

/** Console size used until the OS sends its first `resize`. */
export const INITIAL_COLS = 80;
export const INITIAL_ROWS = 24;

/**
 * Stdout coalescing window (ms). Engine output is batched on this cadence —
 * never one postMessage per byte. Implemented with setTimeout (not rAF):
 * this page normally runs in a hidden 1×1 iframe, where rAF is throttled
 * or fully paused in some browsers.
 */
export const FLUSH_INTERVAL_MS = 16;

/** Flush early if this much output is buffered (bytes), to bound latency
 *  and message size during output floods (e.g. `cat` on a large file). */
export const FLUSH_MAX_BYTES = 64 * 1024;

/** Cap on output buffered before the OS handshake completes (bytes).
 *  Holds the first bash prompt so it isn't lost if bash beats the OS's
 *  hello; oldest bytes are dropped past the cap. */
export const BACKLOG_MAX_BYTES = 128 * 1024;

/**
 * How long after launching the shell we consider it "booted and streaming"
 * even if it has not printed anything yet. Ready normally fires on the
 * first output byte (the bash prompt); this is a safety net so a silent
 * shell can never hang the handshake forever.
 */
export const READY_FALLBACK_MS = 2000;

/**
 * Origins allowed to drive this page via postMessage, in addition to this
 * page's own origin (in production the OS is the *same* origin:
 * dragon-gaming-platforms.github.io hosts both project sites), localhost
 * origins for development (see ALLOW_LOCALHOST_PARENTS), and the generated
 * preview origins matched by ALLOWED_PARENT_ORIGIN_PATTERNS below.
 * Add the OS's origin here if it ever moves to a custom domain.
 */
export const ALLOWED_PARENT_ORIGINS: readonly string[] = [
  "https://dragon-gaming-platforms.github.io",
];

/**
 * Origin *patterns* allowed as parents, for environments whose origins are
 * generated per session rather than fixed. Currently: Arena agent preview
 * hosts (https://<port>-<sandbox-id>.e2b.app), so embedded testing from an
 * agent preview can complete the bridge handshake. Note this only governs
 * the message layer — a cross-origin parent must ALSO be cross-origin
 * isolated itself for this page to get SharedArrayBuffer (see README →
 * "OS integration").
 */
export const ALLOWED_PARENT_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/,
];

/** Allow http(s)://localhost:<any port> and 127.0.0.1 as parents (OS dev). */
export const ALLOW_LOCALHOST_PARENTS = true;
