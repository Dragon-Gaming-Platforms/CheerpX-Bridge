import {
  FS_PROTOCOL_VERSION,
  parseFsRequest,
  type FsEntry,
  type FsRequestMessage,
  type FsResponseMessage,
  type FsTreeEntry,
} from "./bridge/protocol";
import { FS_CAP, PROTOCOL_VERSION } from "./config";

/**
 * embed-test.html — a minimal stand-in for the Dragon86 OS parent page.
 *
 * Mirrors src/bridge/hoster.ts in the OS repo: hidden 1×1 iframe, hello
 * repeated every 400ms after (each) iframe load, 6s timeout, identical
 * message shapes sent with targetOrigin "*". Unlike the OS it keeps
 * listening after the timeout so you can watch a slow first boot finish.
 *
 * It also plays the OS side of the "fs1" shared-folder protocol: hello
 * advertises caps:["fs1"], and an in-memory fake filesystem answers the
 * hoster's fs-req messages (mirroring src/bridge/fs-bridge.ts in the OS
 * repo). Files created here appear in the guest's ~/shared within a few
 * seconds; files created in the guest appear here. The fs1 line flips
 * to LIVE when the hoster echoes the capability in a ready — proof the
 * whole agent+sync loop is actually running.
 *
 * This page is deliberately NOT cross-origin isolated — only the engine
 * iframe needs to be, and it isolates itself via its service worker.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

const handshakeEl = el("handshake");
const fsStatusEl = el("fsstatus");
const fsListEl = el("fslist");
const outEl = el("out");
const logEl = el("log");
const cmdEl = el<HTMLInputElement>("cmd");
const colsEl = el<HTMLInputElement>("cols");
const rowsEl = el<HTMLInputElement>("rows");
const fsNameEl = el<HTMLInputElement>("fsname");

function log(direction: string, msg: unknown): void {
  let shown = typeof msg === "string" ? msg : JSON.stringify(msg);
  if (shown !== undefined && shown.length > 220) {
    shown = `${shown.slice(0, 220)}… (${shown.length} chars)`;
  }
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()} ${direction} ${shown}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function appendOut(text: string): void {
  outEl.append(document.createTextNode(text.replace(/\x1b/g, "␛")));
  outEl.scrollTop = outEl.scrollHeight;
}

let iframe: HTMLIFrameElement | null = null;
let helloTimer: number | null = null;
let timeoutTimer: number | null = null;
let settled = false;
let fsLive = false;
let connectStartedAt = 0;

function post(msg: unknown): void {
  log("os → hoster ", msg);
  iframe?.contentWindow?.postMessage(msg, "*"); // exactly like the OS
}

function postFs(res: FsResponseMessage): void {
  const detail =
    res.data !== undefined ? ` (${res.data.length} bytes)` : "";
  log(
    "os → hoster ",
    `fs-res #${res.id} ${res.ok ? "ok" : `ERR ${res.error ?? "?"}`}${detail}`,
  );
  iframe?.contentWindow?.postMessage(res, "*");
}

function clearTimers(): void {
  if (helloTimer !== null) window.clearInterval(helloTimer);
  if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
  helloTimer = timeoutTimer = null;
}

function connect(): void {
  clearTimers();
  iframe?.remove();
  settled = false;
  fsLive = false;
  connectStartedAt = performance.now();
  handshakeEl.className = "";
  handshakeEl.textContent = "handshake: waiting for ready…";
  fsStatusEl.className = "";
  fsStatusEl.textContent = "fs1: waiting for the hoster to echo the cap…";

  const frame = document.createElement("iframe");
  frame.src = "./index.html";
  // Same hidden-iframe styling as the OS.
  frame.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-9999px;";
  frame.setAttribute("aria-hidden", "true");
  frame.addEventListener("load", () => {
    // Fires again after the hoster's one-time service-worker reload —
    // restart the hello loop on each load, like the OS does.
    log("iframe      ", "load event");
    if (helloTimer !== null) window.clearInterval(helloTimer);
    const sendHello = () =>
      post({ v: PROTOCOL_VERSION, t: "hello", caps: [FS_CAP] });
    sendHello();
    helloTimer = window.setInterval(sendHello, 400);
  });
  document.body.append(frame);
  iframe = frame;

  timeoutTimer = window.setTimeout(() => {
    if (settled) return;
    handshakeEl.className = "bad";
    handshakeEl.textContent =
      "handshake: no ready within 6s — the real OS shows “not connected” now (this page keeps listening; a cold first boot can take longer)";
    log("timeout     ", "6s without ready (OS budget)");
  }, 6000);
}

window.addEventListener("message", (ev) => {
  if (iframe === null || ev.source !== iframe.contentWindow) return;
  const raw = ev.data as { v?: unknown } | null;

  // protocol-v2 shared-folder requests (answered regardless of v1 state)
  if (raw !== null && raw.v === FS_PROTOCOL_VERSION) {
    const req = parseFsRequest(ev.data);
    if (req === null) return;
    const bytes = req.data !== undefined ? ` (${req.data.length} bytes)` : "";
    log(
      "hoster → os ",
      `fs-req #${req.id} ${req.op} ${req.path ?? ""}${req.to !== undefined ? ` → ${req.to}` : ""}${bytes}`,
    );
    postFs(handleFsRequest(req));
    return;
  }

  const msg = ev.data as
    | { v?: unknown; t?: unknown; d?: unknown; code?: unknown; caps?: unknown }
    | null;
  if (msg === null || msg.v !== PROTOCOL_VERSION) return;
  log("hoster → os ", msg);
  switch (msg.t) {
    case "ready": {
      const caps = Array.isArray(msg.caps) ? msg.caps : [];
      if (caps.includes(FS_CAP) && !fsLive) {
        fsLive = true;
        fsStatusEl.className = "ok";
        fsStatusEl.textContent =
          "fs1: LIVE ✓ — the hoster confirmed the shared folder is mounted + syncing";
      }
      if (settled) break; // re-announced ready (caps update)
      const ms = Math.round(performance.now() - connectStartedAt);
      settled = true;
      clearTimers();
      handshakeEl.className = "ok";
      handshakeEl.textContent = `handshake: READY ✓ in ${ms}ms (this page crossOriginIsolated=${window.crossOriginIsolated}, as expected)`;
      break;
    }
    case "data":
      if (typeof msg.d === "string") appendOut(msg.d);
      break;
    case "exit":
      appendOut(`\r\n[process exited: ${String(msg.code ?? 0)}]\r\n`);
      break;
  }
});

function sendCommand(): void {
  const value = cmdEl.value;
  cmdEl.value = "";
  post({ v: PROTOCOL_VERSION, t: "data", d: `${value}\r` });
  cmdEl.focus();
}

cmdEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") sendCommand();
});
el("send").addEventListener("click", sendCommand);
el("echo").addEventListener("click", () => {
  post({ v: PROTOCOL_VERSION, t: "data", d: "echo hi\r" });
});
el("ctrlc").addEventListener("click", () => {
  post({ v: PROTOCOL_VERSION, t: "data", d: "\x03" });
});
el("resize").addEventListener("click", () => {
  const cols = Number.parseInt(colsEl.value, 10);
  const rows = Number.parseInt(rowsEl.value, 10);
  if (Number.isFinite(cols) && Number.isFinite(rows)) {
    post({ v: PROTOCOL_VERSION, t: "resize", cols, rows });
  }
});
el("reload").addEventListener("click", () => {
  outEl.textContent = "";
  connect();
});

// ---------------------------------------------------------------------------
// Fake OS filesystem (in-memory). Seeded with a couple of files so the
// OS→guest direction has something to do on first connect. Mirrors the
// real OS responder: whole files, canonical stat on writes, mtime in ms.
// ---------------------------------------------------------------------------

interface FakeNode {
  isDir: boolean;
  data: Uint8Array | null;
  mtime: number;
}

const fakeFs = new Map<string, FakeNode>();

function fakePut(path: string, text: string, mtime = Date.now()): void {
  ensureParents(path);
  fakeFs.set(path, {
    isDir: false,
    data: new TextEncoder().encode(text),
    mtime,
  });
}

function ensureParents(path: string): void {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (!fakeFs.has(dir)) {
      fakeFs.set(dir, { isDir: true, data: null, mtime: Date.now() });
    }
  }
}

function seedFakeFs(): void {
  fakeFs.clear();
  fakeFs.set("notes", { isDir: true, data: null, mtime: Date.now() });
  fakePut(
    "notes/readme.txt",
    "hello from the fake OS — this file started on the embed-test page.\n",
  );
  fakePut("todo.txt", "- try: echo from-guest > ~/shared/hi.txt\n");
  renderFsList();
}

function nodeStat(node: FakeNode): { isDir: boolean; size: number; mtime: number } {
  return {
    isDir: node.isDir,
    size: node.data?.length ?? 0,
    mtime: node.mtime,
  };
}

function normalizeFsPath(path: string | undefined): string {
  return (path ?? "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function childrenOf(dir: string): FsEntry[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const out: FsEntry[] = [];
  for (const [path, node] of fakeFs) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "" || rest.includes("/")) continue;
    out.push({ name: rest, ...nodeStat(node) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function handleFsRequest(req: FsRequestMessage): FsResponseMessage {
  const base: Pick<FsResponseMessage, "v" | "t" | "id"> = {
    v: FS_PROTOCOL_VERSION,
    t: "fs-res",
    id: req.id,
  };
  const fail = (error: string): FsResponseMessage => ({
    ...base,
    ok: false,
    error,
  });
  const path = normalizeFsPath(req.path);
  switch (req.op) {
    case "list": {
      if (path !== "" && !fakeFs.get(path)?.isDir) return fail("ENOTDIR");
      return { ...base, ok: true, entries: childrenOf(path) };
    }
    case "tree": {
      const tree: FsTreeEntry[] = [...fakeFs]
        .map(([p, node]) => ({ path: p, ...nodeStat(node) }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { ...base, ok: true, tree };
    }
    case "read": {
      const node = fakeFs.get(path);
      if (node === undefined) return fail("ENOENT");
      if (node.isDir) return fail("EISDIR");
      return { ...base, ok: true, data: node.data ?? new Uint8Array() };
    }
    case "write": {
      ensureParents(path);
      const node: FakeNode = {
        isDir: false,
        data: req.data ?? new Uint8Array(),
        mtime: Date.now(),
      };
      fakeFs.set(path, node);
      renderFsList();
      return { ...base, ok: true, stat: nodeStat(node) };
    }
    case "mkdir": {
      ensureParents(path);
      const existing = fakeFs.get(path);
      const node: FakeNode =
        existing?.isDir === true
          ? existing
          : { isDir: true, data: null, mtime: Date.now() };
      fakeFs.set(path, node);
      renderFsList();
      return { ...base, ok: true, stat: nodeStat(node) };
    }
    case "remove": {
      if (path === "") return fail("EINVAL");
      if (!fakeFs.has(path)) return fail("ENOENT");
      for (const key of [...fakeFs.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) fakeFs.delete(key);
      }
      renderFsList();
      return { ...base, ok: true };
    }
    case "rename": {
      const to = normalizeFsPath(req.to);
      const node = fakeFs.get(path);
      if (node === undefined || to === "") return fail("ENOENT");
      ensureParents(to);
      const moves: Array<[string, FakeNode]> = [];
      for (const [key, value] of [...fakeFs]) {
        if (key === path) moves.push([to, value]);
        else if (key.startsWith(`${path}/`)) {
          moves.push([`${to}${key.slice(path.length)}`, value]);
        }
      }
      for (const key of [...fakeFs.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) fakeFs.delete(key);
      }
      for (const [key, value] of moves) fakeFs.set(key, value);
      renderFsList();
      return { ...base, ok: true, stat: nodeStat(node) };
    }
    case "stat": {
      const node = fakeFs.get(path);
      if (node === undefined) return fail("ENOENT");
      return { ...base, ok: true, stat: nodeStat(node) };
    }
  }
}

function renderFsList(): void {
  const rows = [...fakeFs].sort(([a], [b]) => a.localeCompare(b));
  fsListEl.replaceChildren();
  if (rows.length === 0) {
    fsListEl.textContent = "(fake OS filesystem is empty)";
    return;
  }
  for (const [path, node] of rows) {
    const row = document.createElement("div");
    row.className = "fsrow";
    const label = document.createElement("span");
    label.textContent = node.isDir
      ? `📁 ${path}/`
      : `📄 ${path} (${node.data?.length ?? 0}b)`;
    row.append(label);
    if (!node.isDir) {
      const view = document.createElement("button");
      view.type = "button";
      view.textContent = "view";
      view.addEventListener("click", () => {
        log("fake-os fs  ", `${path}: ${new TextDecoder().decode(node.data ?? new Uint8Array())}`);
      });
      row.append(view);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "delete";
    del.addEventListener("click", () => {
      for (const key of [...fakeFs.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) fakeFs.delete(key);
      }
      log("fake-os fs  ", `deleted ${path} (expect guest removal within seconds)`);
      renderFsList();
    });
    row.append(del);
    fsListEl.append(row);
  }
}

el("fscreate").addEventListener("click", () => {
  const name = fsNameEl.value.trim().replace(/^\/+/, "") || "from-os.txt";
  fakePut(name, `created on the fake OS at ${new Date().toISOString()}\n`);
  log("fake-os fs  ", `created ${name} (expect it in ~/shared within seconds)`);
  renderFsList();
});

seedFakeFs();
connect();
