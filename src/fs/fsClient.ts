import type { BridgeTransport } from "../bridge/hosterBridge";
import {
  FS_PROTOCOL_VERSION,
  type FsEntry,
  type FsOp,
  type FsRequestMessage,
  type FsResponseMessage,
  type FsStat,
  type FsTreeEntry,
} from "../bridge/protocol";
import { FS_REQUEST_TIMEOUT_MS } from "../config";

/** An fs-req failed: `code` is the OS's errno-ish string or a local one. */
export class FsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FsError";
  }
}

interface PendingRequest {
  resolve: (res: FsResponseMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Protocol-v2 filesystem client. The OS is a stateless file server that
 * answers each fs-req with exactly one fs-res (possibly out of order);
 * this correlates by id, applies a timeout, and exposes one typed
 * method per op. Transport-agnostic: works over iframe postMessage,
 * BroadcastChannel, composite, or loopback.
 */
export class FsClient {
  private readonly pending = new Map<number, PendingRequest>();
  private counter = 0;
  // Random per-instance salt so two hoster tabs sharing one channel
  // can't collide request ids (responses are matched by id alone).
  private readonly salt = Math.floor(Math.random() * 2 ** 31);
  private closed = false;

  constructor(
    private readonly transport: BridgeTransport,
    private readonly timeoutMs: number = FS_REQUEST_TIMEOUT_MS,
  ) {
    transport.onFsMessage((msg) => this.onResponse(msg));
  }

  async request(
    op: FsOp,
    opts: { path?: string; to?: string; data?: Uint8Array } = {},
  ): Promise<FsResponseMessage> {
    if (this.closed) throw new FsError("ECLOSED");
    const id = this.salt + ++this.counter;
    const msg: FsRequestMessage = { v: FS_PROTOCOL_VERSION, t: "fs-req", id, op };
    if (opts.path !== undefined) msg.path = opts.path;
    if (opts.to !== undefined) msg.to = opts.to;
    if (opts.data !== undefined) msg.data = opts.data;
    return new Promise<FsResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FsError("ETIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.sendFs(msg);
    });
  }

  async list(path: string): Promise<FsEntry[]> {
    const res = await this.request("list", { path });
    return res.entries ?? [];
  }

  async tree(path = "/"): Promise<FsTreeEntry[]> {
    const res = await this.request("tree", { path });
    return res.tree ?? [];
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await this.request("read", { path });
    if (res.data === undefined) throw new FsError("EPROTO: read without data");
    return res.data;
  }

  /** Returns the post-write stat the OS reports (its canonical mtime). */
  async write(path: string, data: Uint8Array): Promise<FsStat | null> {
    const res = await this.request("write", { path, data });
    return res.stat ?? null;
  }

  async mkdir(path: string): Promise<FsStat | null> {
    const res = await this.request("mkdir", { path });
    return res.stat ?? null;
  }

  async remove(path: string): Promise<void> {
    await this.request("remove", { path });
  }

  async rename(from: string, to: string): Promise<FsStat | null> {
    const res = await this.request("rename", { path: from, to });
    return res.stat ?? null;
  }

  async stat(path: string): Promise<FsStat> {
    const res = await this.request("stat", { path });
    if (res.stat === undefined) throw new FsError("EPROTO: stat without stat");
    return res.stat;
  }

  /** Reject everything in flight; further requests fail immediately. */
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new FsError("ECLOSED"));
    }
    this.pending.clear();
  }

  private onResponse(msg: FsResponseMessage): void {
    const pending = this.pending.get(msg.id);
    if (pending === undefined) return; // not ours (or already timed out)
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new FsError(msg.error ?? "EIO"));
  }
}
