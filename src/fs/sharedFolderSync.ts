import type { BridgeTransport } from "../bridge/hosterBridge";
import type { FsTreeEntry } from "../bridge/protocol";
import {
  FS_AGENT_STALE_MS,
  FS_CAP,
  FS_MAX_FILE_BYTES,
  FS_PLAN_ACK_TIMEOUT_MS,
  FS_SYNC_INTERVAL_MS,
  SHARED_AGENT_LOG_NAME,
  SHARED_MANIFEST_NAME,
} from "../config";
import type { SharedFolderHooks } from "../engine/adapter";
import { FsClient, FsError } from "./fsClient";

/**
 * Two-way folder sync between the OS's filesystem (reached via the
 * protocol-v2 fs ops) and the guest's shared folder (reached via the
 * engine's SharedFolderHooks: manifest + whole-file reads one way,
 * staged inbox plans applied by the guest agent the other).
 *
 * Change detection is Unison-style: remember each path's last-synced
 * state per side ("known", persisted in localStorage), and compare
 * each side's current state against ITS OWN known state. That cleanly
 * distinguishes "guest edited it" from "OS edited it" from "both did"
 * (conflict) without ever comparing mtimes across sides — important
 * because the two sides have independent mtime quirks (e.g. the OS
 * stamps its own mtime on write).
 *
 * Cycles are serialized and only diff at quiesce: while a plan written
 * to the guest awaits acknowledgment (manifest.appliedPlan catching
 * up), the guest state is mid-application and must not be diffed
 * against — our own writes would look like guest edits.
 */

export interface FileState {
  isDir: boolean;
  size: number;
  /** ms since epoch; compared only within one side. */
  mtime: number;
}

export type StateMap = Map<string, FileState>;

export interface KnownEntry {
  guest: FileState | null;
  os: FileState | null;
}

export type KnownMap = Map<string, KnownEntry>;

/** Work needed to bring the OS in line with the guest. */
export type ToOsOp =
  | { kind: "write"; path: string; state: FileState; replace?: true }
  | { kind: "mkdir"; path: string; state: FileState; replace?: true }
  | { kind: "remove"; path: string }
  | { kind: "rename"; from: string; to: string; state: FileState };

/** Work needed to bring the guest in line with the OS. */
export type ToGuestOp =
  | { kind: "put"; path: string; state: FileState; replace?: true }
  | { kind: "mkdir"; path: string; state: FileState; replace?: true }
  | { kind: "remove"; path: string }
  | { kind: "rename"; from: string; to: string; state: FileState };

export interface DiffResult {
  toOs: ToOsOp[];
  toGuest: ToGuestOp[];
  /** Both sides changed to the same outcome (or both deleted): just record. */
  converged: Map<string, KnownEntry>;
  /** Both changed to same-size files: byte-compare before calling it a conflict. */
  compareCandidates: string[];
  /** Both changed incompatibly (winner already resolved into an op). */
  conflicts: string[];
  /** Present files over the protocol size cap: cannot sync, either way. */
  oversize: string[];
}

export function sameFileState(
  a: FileState | null | undefined,
  b: FileState | null | undefined,
): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (x.isDir !== y.isDir) return false;
  // Directory mtimes change whenever a child changes; only presence matters.
  if (x.isDir) return true;
  return x.size === y.size && x.mtime === y.mtime;
}

const RESERVED_ROOT_FILES: ReadonlySet<string> = new Set([
  SHARED_MANIFEST_NAME,
  SHARED_AGENT_LOG_NAME,
]);

const AGENT_TMP_SUFFIX = ".tmp-agent";

/**
 * Paths eligible for sync. Excludes the protocol's own files (manifest,
 * agent log at the root), agent temp files, and anything malformed.
 * Applied to BOTH sides so a same-named OS file is never synced into
 * the guest and clobbered by the agent.
 */
export function isSyncablePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) return false;
  if (RESERVED_ROOT_FILES.has(path)) return false;
  if (path.endsWith(AGENT_TMP_SUFFIX)) return false;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function filterStates(states: StateMap): StateMap {
  const out: StateMap = new Map();
  for (const [path, state] of states) {
    if (isSyncablePath(path)) out.set(path, state);
  }
  return out;
}

function pairRenames<T extends { kind: string }>(
  ops: T[],
  known: KnownMap,
  side: "guest" | "os",
  makeRename: (from: string, to: string, state: FileState) => T,
  writeKind: string,
): T[] {
  // A delete+create of a same size+mtime file on one side is almost
  // certainly a rename (mv preserves mtime); syncing it as a rename
  // avoids re-transferring the bytes. Falls back to remove+write if
  // anything doesn't line up — correctness never depends on this.
  const result: T[] = [];
  const creates = new Map<string, T & { path: string; state: FileState }>();
  const pairedCreates = new Set<string>();
  for (const op of ops) {
    if (op.kind !== writeKind) continue;
    const w = op as T & { path: string; state: FileState };
    const prev = known.get(w.path)?.[side] ?? null;
    if (prev === null && !w.state.isDir) {
      creates.set(`${w.state.size}:${w.state.mtime}`, w);
    }
  }
  for (const op of ops) {
    if (op.kind === "remove") {
      const r = op as T & { path: string };
      const prev = known.get(r.path)?.[side] ?? null;
      if (prev !== null && !prev.isDir) {
        const key = `${prev.size}:${prev.mtime}`;
        const create = creates.get(key);
        if (create !== undefined && !pairedCreates.has(create.path)) {
          pairedCreates.add(create.path);
          result.push(makeRename(r.path, create.path, create.state));
          continue;
        }
      }
    }
    if (
      op.kind === writeKind &&
      pairedCreates.has((op as unknown as { path: string }).path)
    ) {
      continue; // already emitted as the rename target
    }
    result.push(op);
  }
  return result;
}

/**
 * Pure three-way diff. Conflict policy: deletion loses to modification;
 * otherwise the newer mtime wins, ties go to the OS (it is the user's
 * primary filesystem). Same-size both-changed files are NOT resolved
 * here — they may be byte-identical (e.g. an `install -p` copy) and
 * are returned as compareCandidates for the executor to check.
 */
export function diffStates(
  known: KnownMap,
  guest: StateMap,
  os: StateMap,
  maxFileBytes: number = FS_MAX_FILE_BYTES,
): DiffResult {
  const result: DiffResult = {
    toOs: [],
    toGuest: [],
    converged: new Map(),
    compareCandidates: [],
    conflicts: [],
    oversize: [],
  };
  const paths = new Set<string>([
    ...known.keys(),
    ...guest.keys(),
    ...os.keys(),
  ]);

  const pushGuestWin = (path: string, g: FileState, o: FileState | null) => {
    const replace = o !== null && o.isDir !== g.isDir;
    if (g.isDir) {
      result.toOs.push({ kind: "mkdir", path, state: g, ...(replace ? { replace: true as const } : {}) });
    } else {
      result.toOs.push({ kind: "write", path, state: g, ...(replace ? { replace: true as const } : {}) });
    }
  };
  const pushOsWin = (path: string, o: FileState, g: FileState | null) => {
    const replace = g !== null && g.isDir !== o.isDir;
    if (o.isDir) {
      result.toGuest.push({ kind: "mkdir", path, state: o, ...(replace ? { replace: true as const } : {}) });
    } else {
      result.toGuest.push({ kind: "put", path, state: o, ...(replace ? { replace: true as const } : {}) });
    }
  };

  for (const path of paths) {
    const k = known.get(path);
    const g = guest.get(path) ?? null;
    const o = os.get(path) ?? null;
    const guestChanged = !sameFileState(g, k?.guest ?? null);
    const osChanged = !sameFileState(o, k?.os ?? null);
    if (!guestChanged && !osChanged) continue;

    const guestOversize = g !== null && !g.isDir && g.size > maxFileBytes;
    const osOversize = o !== null && !o.isDir && o.size > maxFileBytes;
    if (guestOversize || osOversize) {
      result.oversize.push(path);
      continue;
    }

    if (guestChanged && !osChanged) {
      if (g === null) {
        if (o !== null) result.toOs.push({ kind: "remove", path });
        else result.converged.set(path, { guest: null, os: null });
      } else {
        pushGuestWin(path, g, o);
      }
      continue;
    }
    if (osChanged && !guestChanged) {
      if (o === null) {
        if (g !== null) result.toGuest.push({ kind: "remove", path });
        else result.converged.set(path, { guest: null, os: null });
      } else {
        pushOsWin(path, o, g);
      }
      continue;
    }

    // Both sides changed since the last sync.
    if (g === null && o === null) {
      result.converged.set(path, { guest: null, os: null });
      continue;
    }
    if (g !== null && o !== null && g.isDir && o.isDir) {
      result.converged.set(path, { guest: g, os: o });
      continue;
    }
    if (
      g !== null &&
      o !== null &&
      !g.isDir &&
      !o.isDir &&
      g.size === o.size
    ) {
      result.compareCandidates.push(path);
      continue;
    }
    result.conflicts.push(path);
    // Deletion loses to modification; otherwise newer mtime wins; tie → OS.
    const guestWins =
      g !== null && (o === null || (!o.isDir && !g.isDir && g.mtime > o.mtime));
    if (guestWins) pushGuestWin(path, g, o);
    else if (o === null) result.toGuest.push({ kind: "remove", path });
    else pushOsWin(path, o, g);
  }

  result.toOs = pairRenames(
    result.toOs,
    known,
    "guest",
    (from, to, state) => ({ kind: "rename", from, to, state }),
    "write",
  );
  result.toGuest = pairRenames(
    result.toGuest,
    known,
    "os",
    (from, to, state) => ({ kind: "rename", from, to, state }),
    "put",
  );
  return result;
}

// ---------------------------------------------------------------------------
// Guest manifest (written by guestAgent.py into the shared folder)
// ---------------------------------------------------------------------------

export interface GuestManifest {
  bootId: string;
  cycle: number;
  appliedPlan: number;
  generatedAtMs: number;
  lastError: string | null;
  states: StateMap;
}

export function parseManifest(bytes: Uint8Array): GuestManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null; // torn/corrupt read — next poll will see a clean one
  }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.bootId !== "string" ||
    typeof m.cycle !== "number" ||
    typeof m.appliedPlan !== "number" ||
    !Array.isArray(m.entries)
  ) {
    return null;
  }
  const states: StateMap = new Map();
  for (const item of m.entries) {
    if (typeof item !== "object" || item === null) return null;
    const e = item as Record<string, unknown>;
    if (
      typeof e.path !== "string" ||
      typeof e.isDir !== "boolean" ||
      typeof e.size !== "number" ||
      typeof e.mtimeMs !== "number"
    ) {
      return null;
    }
    states.set(e.path, { isDir: e.isDir, size: e.size, mtime: e.mtimeMs });
  }
  return {
    bootId: m.bootId,
    cycle: m.cycle,
    appliedPlan: m.appliedPlan,
    generatedAtMs: typeof m.generatedAtMs === "number" ? m.generatedAtMs : 0,
    lastError: typeof m.lastError === "string" ? m.lastError : null,
    states,
  };
}

// ---------------------------------------------------------------------------
// Known-state persistence (survives hoster reloads; without it every
// reload looks like "everything changed on both sides").
// ---------------------------------------------------------------------------

export const KNOWN_STORAGE_KEY = "dragon86-hoster-fs-known-v1";

function loadKnown(): KnownMap {
  try {
    if (typeof localStorage === "undefined") return new Map();
    const raw = localStorage.getItem(KNOWN_STORAGE_KEY);
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return new Map();
    const out: KnownMap = new Map();
    for (const item of parsed.entries) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const sides = item[1] as { g?: unknown; o?: unknown };
      out.set(item[0], {
        guest: reviveState(sides?.g),
        os: reviveState(sides?.o),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

function reviveState(raw: unknown): FileState | null {
  if (raw === null || raw === undefined) return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.isDir === "boolean" &&
    typeof s.size === "number" &&
    typeof s.mtime === "number"
  ) {
    return { isDir: s.isDir, size: s.size, mtime: s.mtime };
  }
  return null;
}

function saveKnown(known: KnownMap): void {
  try {
    if (typeof localStorage === "undefined") return;
    const entries = [...known].map(([path, sides]) => [
      path,
      { g: sides.guest, o: sides.os },
    ]);
    localStorage.setItem(KNOWN_STORAGE_KEY, JSON.stringify({ entries }));
  } catch {
    // Quota/storage errors must never break sync; worst case the next
    // session re-derives state with one conservative pass.
  }
}

// ---------------------------------------------------------------------------
// The sync engine
// ---------------------------------------------------------------------------

type AgentPlanOp =
  | { op: "put"; path: string; staged: string; mtimeMs: number }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string }
  | { op: "rename"; path: string; to: string };

export interface SharedFolderSyncHooks {
  /** Human-readable sync state for the status page. */
  onStatus?: (text: string) => void;
  /** True once the agent is alive and a full clean cycle has completed. */
  onLiveChange?: (live: boolean) => void;
}

function describeError(err: unknown): string {
  if (err instanceof FsError) return err.code;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class SharedFolderSync {
  /** Agent alive + at least one clean full cycle + no plan in flight. */
  live = false;

  private readonly client: FsClient;
  private known: KnownMap;
  private peerFs = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleRunning = false;
  private stopped = false;
  private completedCycle = false;
  private lastManifestKey = "";
  private agentSeenAt = 0;
  private lastPlanSeq: number | null = null;
  private pendingAck: {
    seq: number;
    since: number;
    updates: Map<string, KnownEntry>;
  } | null = null;
  private readonly stagedBlobs = new Set<string>();
  private readonly warnedOversize = new Set<string>();
  private statusText = "";

  constructor(
    transport: BridgeTransport,
    private readonly device: SharedFolderHooks,
    private readonly hooks: SharedFolderSyncHooks = {},
  ) {
    this.client = new FsClient(transport);
    this.known = loadKnown();
    this.setStatus("waiting for an fs1-capable OS…");
  }

  /** Called whenever the peer's hello caps change. */
  setPeerCaps(caps: string[]): void {
    const has = caps.includes(FS_CAP);
    if (has === this.peerFs) return;
    this.peerFs = has;
    if (has) {
      this.setStatus("waiting for guest agent…");
      void this.syncOnce();
    } else {
      this.setStatus("OS did not offer fs1 — shared folder idle");
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.syncOnce(), FS_SYNC_INTERVAL_MS);
    void this.syncOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.client.close();
  }

  /**
   * One sync cycle (also the test seam: call directly instead of
   * waiting for the timer). No-ops unless the peer advertised fs1.
   */
  async syncOnce(): Promise<void> {
    if (this.stopped || this.cycleRunning || !this.peerFs) return;
    this.cycleRunning = true;
    try {
      await this.cycle();
    } catch (err) {
      this.setStatus(`sync paused: ${describeError(err)}`);
    } finally {
      this.cycleRunning = false;
    }
  }

  private setStatus(text: string): void {
    if (text === this.statusText) return;
    this.statusText = text;
    this.hooks.onStatus?.(text);
  }

  private setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.hooks.onLiveChange?.(live);
  }

  private agentAlive(): boolean {
    return (
      this.agentSeenAt > 0 && Date.now() - this.agentSeenAt < FS_AGENT_STALE_MS
    );
  }

  private async readManifest(): Promise<GuestManifest | null> {
    const bytes = await this.device.readSharedFile(SHARED_MANIFEST_NAME);
    if (bytes === null) return null;
    return parseManifest(bytes);
  }

  private async cycle(): Promise<void> {
    const manifest = await this.readManifest();
    if (manifest === null) {
      this.setStatus(
        this.agentSeenAt > 0
          ? `guest agent not responding (see ${SHARED_AGENT_LOG_NAME} in the shared folder)`
          : "waiting for guest agent…",
      );
      return;
    }
    const manifestKey = `${manifest.bootId}:${manifest.cycle}`;
    if (manifestKey !== this.lastManifestKey) {
      this.lastManifestKey = manifestKey;
      this.agentSeenAt = Date.now();
    }
    if (this.lastPlanSeq === null) this.lastPlanSeq = manifest.appliedPlan;

    if (this.pendingAck !== null) {
      if (manifest.appliedPlan >= this.pendingAck.seq) {
        // Fold in the guest state we PREDICTED when writing the plan
        // (the agent stamps OS mtimes), not whatever the manifest says
        // now — a user edit racing the apply must still be detected.
        for (const [path, entry] of this.pendingAck.updates) {
          if (entry.guest === null && entry.os === null) {
            this.known.delete(path);
          } else {
            this.known.set(path, entry);
          }
        }
        this.pendingAck = null;
        saveKnown(this.known);
      } else if (Date.now() - this.pendingAck.since > FS_PLAN_ACK_TIMEOUT_MS) {
        this.setStatus(
          `guest agent is not applying sync plans (see ${SHARED_AGENT_LOG_NAME} in the shared folder)`,
        );
        return;
      } else {
        return; // still being applied; diffing now would see our own writes
      }
    }

    const tree = await this.client.tree("/");
    const guestStates = filterStates(manifest.states);
    const osStates = filterStates(treeToMap(tree));

    const diff = diffStates(this.known, guestStates, osStates);
    for (const [path, entry] of diff.converged) {
      if (entry.guest === null && entry.os === null) this.known.delete(path);
      else this.known.set(path, entry);
    }
    for (const path of diff.oversize) {
      if (!this.warnedOversize.has(path)) {
        this.warnedOversize.add(path);
        console.warn(
          `[dragon86-hoster] shared folder: "${path}" exceeds the ` +
            `${FS_MAX_FILE_BYTES} byte sync limit and will be skipped.`,
        );
      }
    }

    const preloaded = new Map<string, Uint8Array>();
    for (const path of diff.compareCandidates) {
      await this.resolveCompare(path, guestStates, osStates, diff, preloaded);
    }
    for (const op of diff.toOs) await this.execToOs(op);
    if (diff.toGuest.length > 0) {
      await this.execToGuest(diff.toGuest, preloaded);
    }
    saveKnown(this.known);
    this.completedCycle = true;

    this.setLive(this.agentAlive() && this.pendingAck === null);
    if (this.live) {
      const files = [...osStates.values()].filter((s) => !s.isDir).length;
      this.setStatus(
        `syncing ✓ · ${files} file${files === 1 ? "" : "s"}` +
          (diff.conflicts.length > 0
            ? ` · ${diff.conflicts.length} conflict(s) auto-resolved`
            : "") +
          (diff.oversize.length > 0
            ? ` · ${diff.oversize.length} oversize file(s) skipped`
            : ""),
      );
    } else {
      this.setStatus("initial sync in progress…");
    }
  }

  /** Same-size both-changed: identical bytes mean converged, else conflict. */
  private async resolveCompare(
    path: string,
    guestStates: StateMap,
    osStates: StateMap,
    diff: DiffResult,
    preloaded: Map<string, Uint8Array>,
  ): Promise<void> {
    const g = guestStates.get(path);
    const o = osStates.get(path);
    if (g === undefined || o === undefined) return;
    const guestBytes = await this.device.readSharedFile(path);
    if (guestBytes === null) return; // vanished mid-cycle; next cycle re-diffs
    const osBytes = await this.client.read(path);
    if (bytesEqual(guestBytes, osBytes)) {
      this.known.set(path, { guest: g, os: o });
      return;
    }
    diff.conflicts.push(path);
    if (g.mtime > o.mtime) {
      const stat = await this.client.write(path, guestBytes);
      this.known.set(path, {
        guest: g,
        os: stat ?? { isDir: false, size: guestBytes.length, mtime: g.mtime },
      });
    } else {
      preloaded.set(path, osBytes);
      diff.toGuest.push({ kind: "put", path, state: o });
    }
  }

  private async execToOs(op: ToOsOp): Promise<void> {
    switch (op.kind) {
      case "write": {
        const bytes = await this.device.readSharedFile(op.path);
        if (bytes === null) return; // deleted between manifest and read
        if (bytes.length > FS_MAX_FILE_BYTES) return; // grew past the cap
        if (op.replace) await this.removeOnOs(op.path);
        const stat = await this.client.write(op.path, bytes);
        this.known.set(op.path, {
          guest: op.state,
          os: stat ?? { isDir: false, size: bytes.length, mtime: op.state.mtime },
        });
        return;
      }
      case "mkdir": {
        if (op.replace) await this.removeOnOs(op.path);
        const stat = await this.client.mkdir(op.path);
        this.known.set(op.path, {
          guest: op.state,
          os: stat ?? op.state,
        });
        return;
      }
      case "remove": {
        await this.removeOnOs(op.path);
        this.known.delete(op.path);
        return;
      }
      case "rename": {
        const stat = await this.client.rename(op.from, op.to);
        this.known.delete(op.from);
        this.known.set(op.to, { guest: op.state, os: stat ?? op.state });
        return;
      }
    }
  }

  /** remove on the OS, treating "already gone" as success. */
  private async removeOnOs(path: string): Promise<void> {
    try {
      await this.client.remove(path);
    } catch (err) {
      if (err instanceof FsError && /ENOENT|not exist/i.test(err.code)) return;
      throw err;
    }
  }

  private async execToGuest(
    ops: ToGuestOp[],
    preloaded: Map<string, Uint8Array>,
  ): Promise<void> {
    const planOps: AgentPlanOp[] = [];
    const updates = new Map<string, KnownEntry>();
    for (const op of ops) {
      switch (op.kind) {
        case "put": {
          const data =
            preloaded.get(op.path) ?? (await this.client.read(op.path));
          const staged = `blob-${await sha256Hex(data)}`;
          // Content-addressed names + this set sidestep the unknown
          // overwrite semantics of DataDevice.writeFile: each name is
          // written at most once per session, with immutable content.
          if (!this.stagedBlobs.has(staged)) {
            await this.device.stageInboxFile(staged, data);
            this.stagedBlobs.add(staged);
          }
          if (op.replace) planOps.push({ op: "remove", path: op.path });
          planOps.push({
            op: "put",
            path: op.path,
            staged,
            mtimeMs: op.state.mtime,
          });
          updates.set(op.path, { guest: op.state, os: op.state });
          break;
        }
        case "mkdir": {
          if (op.replace) planOps.push({ op: "remove", path: op.path });
          planOps.push({ op: "mkdir", path: op.path });
          updates.set(op.path, { guest: op.state, os: op.state });
          break;
        }
        case "remove": {
          planOps.push({ op: "remove", path: op.path });
          updates.set(op.path, { guest: null, os: null });
          break;
        }
        case "rename": {
          planOps.push({ op: "rename", path: op.from, to: op.to });
          updates.set(op.from, { guest: null, os: null });
          updates.set(op.to, { guest: op.state, os: op.state });
          break;
        }
      }
    }
    if (planOps.length === 0) return;
    const seq = (this.lastPlanSeq ?? 0) + 1;
    this.lastPlanSeq = seq;
    await this.device.stageInboxFile(
      `plan-${seq}.json`,
      JSON.stringify({ seq, ops: planOps }),
    );
    this.pendingAck = { seq, since: Date.now(), updates };
  }
}

function treeToMap(tree: FsTreeEntry[]): StateMap {
  const out: StateMap = new Map();
  for (const entry of tree) {
    out.set(entry.path, {
      isDir: entry.isDir,
      size: entry.size,
      mtime: entry.mtime,
    });
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
