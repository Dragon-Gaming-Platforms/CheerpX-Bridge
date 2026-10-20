/**
 * Bridge protocol regression tests (run with `npm test`).
 *
 * These exercise the engine-free protocol layer in Node: message
 * validation, the origin allowlist, ready gating, stdout coalescing,
 * UTF-8 streaming decode, backlog replay and exit ordering, plus the
 * BroadcastChannel (engine-tab) and composite transports. The CheerpX
 * engine itself can only be tested in a browser (see debug.html).
 */
import {
  BroadcastChannelTransport,
  CompositeTransport,
  HosterBridge,
  LoopbackTransport,
  PostMessageTransport,
  type BridgeTransport,
} from "../src/bridge/hosterBridge";
import {
  FS_PROTOCOL_VERSION,
  isOriginAllowed,
  parseFsRequest,
  parseFsResponse,
  parseIncomingMessage,
  type FsRequestMessage,
  type FsResponseMessage,
  type IncomingMessage,
  type OutgoingMessage,
} from "../src/bridge/protocol";
import { BROADCAST_CHANNEL_NAME, FS_CAP } from "../src/config";
import type { SharedFolderHooks } from "../src/engine/adapter";
import { FsClient, FsError } from "../src/fs/fsClient";
import {
  diffStates,
  isSyncablePath,
  parseManifest,
  SharedFolderSync,
  type FileState,
  type KnownMap,
  type StateMap,
} from "../src/fs/sharedFolderSync";

// --- Minimal browser-environment stub (src modules touch `window` only
// at call time, never at import time, so stubbing here is safe). ---
const messageListeners: Array<(ev: unknown) => void> = [];
const fakeParent = {
  posted: [] as Array<{ msg: unknown; origin: string }>,
  postMessage(msg: unknown, origin: string) {
    this.posted.push({ msg, origin });
  },
};
const fakeWindow = {
  location: { origin: "https://dragon-gaming-platforms.github.io" },
  parent: fakeParent as unknown,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  addEventListener(_type: string, fn: (ev: unknown) => void) {
    messageListeners.push(fn);
  },
};
fakeWindow.parent = fakeParent;
(globalThis as Record<string, unknown>).window = fakeWindow;
// HosterBridge/PostMessageTransport compare `window.parent === window`;
// our fake parent is a different object, like a real embedded frame.

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`ok - ${name}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

// ---------- parseIncomingMessage ----------
check("hello parses", parseIncomingMessage({ v: 1, t: "hello" })?.t === "hello");
check(
  "data parses",
  parseIncomingMessage({ v: 1, t: "data", d: "x" })?.t === "data",
);
check(
  "resize parses",
  parseIncomingMessage({ v: 1, t: "resize", cols: 80, rows: 24 })?.t ===
    "resize",
);
check("wrong version rejected", parseIncomingMessage({ v: 2, t: "hello" }) === null);
check("missing version rejected", parseIncomingMessage({ t: "hello" }) === null);
check(
  "non-string data rejected",
  parseIncomingMessage({ v: 1, t: "data", d: 42 }) === null,
);
check(
  "NaN resize rejected",
  parseIncomingMessage({ v: 1, t: "resize", cols: NaN, rows: 24 }) === null,
);
check(
  "outgoing-only type rejected inbound",
  parseIncomingMessage({ v: 1, t: "ready" }) === null,
);
check("null rejected", parseIncomingMessage(null) === null);
check("string rejected", parseIncomingMessage("hello") === null);
{
  const r = parseIncomingMessage({ v: 1, t: "resize", cols: 0, rows: 99999 });
  check(
    "resize clamped to sane bounds",
    r?.t === "resize" && r.cols === 1 && r.rows === 1000,
  );
  const f = parseIncomingMessage({ v: 1, t: "resize", cols: 80.9, rows: 24.2 });
  check(
    "resize floored to integers",
    f?.t === "resize" && f.cols === 80 && f.rows === 24,
  );
}

// ---------- isOriginAllowed ----------
check("own origin allowed", isOriginAllowed("https://dragon-gaming-platforms.github.io"));
check("localhost any port allowed", isOriginAllowed("http://localhost:5173"));
check("127.0.0.1 allowed", isOriginAllowed("http://127.0.0.1:8080"));
check("foreign origin rejected", !isOriginAllowed("https://evil.example.com"));
check(
  "lookalike subdomain rejected",
  !isOriginAllowed("https://dragon-gaming-platforms.github.io.evil.com"),
);
check(
  "localhost lookalike rejected",
  !isOriginAllowed("http://localhost.evil.com:5173"),
);
check("null origin rejected", !isOriginAllowed("null"));
check(
  "Arena preview origin allowed",
  isOriginAllowed("https://4173-iatqo3b0pn2z37cg2tiql.e2b.app"),
);
check("e2b over http rejected", !isOriginAllowed("http://4173-abc123.e2b.app"));
check(
  "e2b suffix attack rejected",
  !isOriginAllowed("https://4173-abc123.e2b.app.evil.com"),
);
check(
  "e2b without leading port rejected",
  !isOriginAllowed("https://abc123-4173.e2b.app"),
);
check("bare e2b.app rejected", !isOriginAllowed("https://e2b.app"));
check("e2b with empty id rejected", !isOriginAllowed("https://4173-.e2b.app"));

// ---------- HosterBridge over LoopbackTransport ----------
async function bridgeTests(): Promise<void> {
  const sent: OutgoingMessage[] = [];
  const written: string[] = [];
  const resizes: Array<[number, number]> = [];
  const transport = new LoopbackTransport();
  transport.onPeerMessage((m) => sent.push(m));
  const bridge = new HosterBridge(transport, {
    write: (d) => written.push(d),
    resize: (c, r) => resizes.push([c, r]),
  });

  // Output before handshake is held as backlog, not sent.
  bridge.acceptOutput(enc.encode("user@dragon86:~$ "));
  check("no output before hello+ready", sent.length === 0);

  // Hello alone must not produce ready (engine not up yet).
  transport.sendToHoster({ v: 1, t: "hello" });
  check("no ready before engine is up", sent.length === 0);

  // Engine up → ready first, then backlog replayed as one data message.
  bridge.markEngineReady();
  check("ready sent once engine up", sent[0]?.t === "ready" && sent[0]?.v === 1);
  check(
    "backlog flushed right after ready",
    sent[1]?.t === "data" && sent[1].d === "user@dragon86:~$ ",
  );

  // Coalescing: several chunks inside one window → exactly one message.
  sent.length = 0;
  for (const s of ["e", "c", "h", "o", " hi\r\n"]) bridge.acceptOutput(enc.encode(s));
  check("nothing sent inside the flush window", sent.length === 0);
  await sleep(30);
  check(
    "chunks coalesced into one data message",
    sent.length === 1 && sent[0].t === "data" && sent[0].d === "echo hi\r\n",
  );

  // UTF-8 sequence split across flushes must not become replacement chars.
  sent.length = 0;
  const eAcute = enc.encode("é"); // 0xC3 0xA9
  bridge.acceptOutput(eAcute.subarray(0, 1));
  await sleep(30);
  bridge.acceptOutput(eAcute.subarray(1));
  await sleep(30);
  const joined = sent.map((m) => (m.t === "data" ? m.d : "")).join("");
  check("split UTF-8 decodes cleanly", joined === "é");

  // Inbound data/resize reach the engine (resize already clamped).
  transport.sendToHoster({ v: 1, t: "data", d: "ls\r" });
  transport.sendToHoster({ v: 1, t: "resize", cols: 120, rows: 40 });
  check("data forwarded to engine stdin", written.join("") === "ls\r");
  check("resize forwarded to engine", resizes[0]?.[0] === 120 && resizes[0]?.[1] === 40);

  // Exit: pending output is flushed BEFORE the exit message, exactly once.
  sent.length = 0;
  bridge.acceptOutput(enc.encode("logout\r\n"));
  bridge.acceptExit(0);
  bridge.acceptExit(0);
  check(
    "final output precedes exit, exit sent once",
    sent.length === 2 &&
      sent[0].t === "data" &&
      sent[1].t === "exit" &&
      sent[1].code === 0,
  );

  // After exit, input is dropped.
  transport.sendToHoster({ v: 1, t: "data", d: "x" });
  check("input after exit dropped", written.join("") === "ls\r");

  // Engine dying before the handshake → total silence (OS times out).
  const sent2: OutgoingMessage[] = [];
  const transport2 = new LoopbackTransport();
  transport2.onPeerMessage((m) => sent2.push(m));
  const bridge2 = new HosterBridge(transport2, { write() {}, resize() {} });
  transport2.sendToHoster({ v: 1, t: "hello" });
  bridge2.acceptExit(1);
  check("exit before ready stays silent", sent2.length === 0);
}

// ---------- PostMessageTransport ----------
function postMessageTests(): void {
  const received: unknown[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));
  let peerOrigin: string | null = null;
  const transport = new PostMessageTransport((o) => (peerOrigin = o));
  transport.onMessage((m) => received.push(m));

  const dispatch = (ev: unknown) => messageListeners.forEach((fn) => fn(ev));
  const hello = { v: 1, t: "hello" };

  dispatch({ source: {}, origin: "https://dragon-gaming-platforms.github.io", data: hello });
  check("message from non-parent source ignored", received.length === 0);

  dispatch({ source: fakeParent, origin: "https://evil.example.com", data: hello });
  check("message from disallowed origin ignored", received.length === 0);
  check(
    "rejected hello warns once and names the origin",
    warnings.length === 1 && warnings[0].includes("https://evil.example.com"),
  );

  dispatch({ source: fakeParent, origin: "https://evil.example.com", data: hello });
  check(
    "repeated rejected hello neither warns nor passes",
    warnings.length === 1 && received.length === 0,
  );

  dispatch({
    source: fakeParent,
    origin: "https://evil.example.com",
    data: { v: 1, t: "data", d: "x" },
  });
  check("non-hello from disallowed origin stays silent", warnings.length === 1);

  dispatch({ source: fakeParent, origin: "https://other.example.com", data: hello });
  check(
    "a second disallowed origin warns separately",
    warnings.length === 2 && warnings[1].includes("https://other.example.com"),
  );

  dispatch({ source: fakeParent, origin: "https://dragon-gaming-platforms.github.io", data: { v: 9, t: "hello" } });
  check("malformed message ignored", received.length === 0);

  dispatch({ source: fakeParent, origin: "http://localhost:5173", data: hello });
  check("valid hello from parent accepted", received.length === 1);
  check("peer origin learned from hello", peerOrigin === "http://localhost:5173");

  transport.send({ v: 1, t: "ready" });
  check(
    "reply addressed to exact peer origin (never *)",
    fakeParent.posted.length === 1 &&
      fakeParent.posted[0].origin === "http://localhost:5173",
  );

  check("no warnings from allowed-origin traffic", warnings.length === 2);
  console.warn = originalWarn;
}

// ---------- BroadcastChannelTransport (engine-tab mode) ----------

type FakeChannelListener = (ev: { data: unknown }) => void;

/** Spec-flavored fake: delivers to every same-name instance except the sender. */
class FakeBroadcastChannel {
  private static readonly registry = new Map<
    string,
    Set<FakeBroadcastChannel>
  >();
  private readonly listeners: FakeChannelListener[] = [];

  constructor(private readonly channelName: string) {
    let peers = FakeBroadcastChannel.registry.get(channelName);
    if (peers === undefined) {
      peers = new Set();
      FakeBroadcastChannel.registry.set(channelName, peers);
    }
    peers.add(this);
  }

  static reset(): void {
    FakeBroadcastChannel.registry.clear();
  }

  postMessage(data: unknown): void {
    const clone = JSON.parse(JSON.stringify(data)) as unknown;
    for (const peer of FakeBroadcastChannel.registry.get(this.channelName) ??
      []) {
      if (peer !== this) peer.deliver(clone);
    }
  }

  addEventListener(_type: string, fn: FakeChannelListener): void {
    this.listeners.push(fn);
  }

  private deliver(data: unknown): void {
    for (const fn of this.listeners) fn({ data });
  }
}

function setGlobalBroadcastChannel(value: unknown): void {
  (globalThis as Record<string, unknown>).BroadcastChannel = value;
}

function broadcastChannelUnavailableTests(): void {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) =>
    warnings.push(args.map(String).join(" "));
  setGlobalBroadcastChannel(undefined);
  try {
    const t1 = new BroadcastChannelTransport("unavailable-test");
    const t2 = new BroadcastChannelTransport("unavailable-test");
    check(
      "missing BroadcastChannel: no crash, marked unavailable",
      !t1.available && !t2.available,
    );
    t1.send({ v: 1, t: "ready" }); // must not throw
    check(
      "missing BroadcastChannel: warned exactly once",
      warnings.length === 1 && warnings[0].includes("BroadcastChannel"),
    );
  } finally {
    console.warn = originalWarn;
    setGlobalBroadcastChannel(FakeBroadcastChannel);
  }
}

function broadcastChannelTests(): void {
  setGlobalBroadcastChannel(FakeBroadcastChannel);
  FakeBroadcastChannel.reset();

  check(
    "channel name matches the OS contract",
    BROADCAST_CHANNEL_NAME === "dragon86-hoster-v1",
  );

  const received: IncomingMessage[] = [];
  let helloCount = 0;
  const transport = new BroadcastChannelTransport(
    BROADCAST_CHANNEL_NAME,
    () => helloCount++,
  );
  transport.onMessage((m) => received.push(m));
  check("BC transport reports available", transport.available);

  const fakeOs = new FakeBroadcastChannel(BROADCAST_CHANNEL_NAME);
  const osReceived: Array<Record<string, unknown>> = [];
  fakeOs.addEventListener("message", (ev) =>
    osReceived.push(ev.data as Record<string, unknown>),
  );

  fakeOs.postMessage({ v: 1, t: "hello" });
  check(
    "hello over channel reaches handler, onHello fires",
    received.length === 1 && received[0].t === "hello" && helloCount === 1,
  );

  fakeOs.postMessage({ v: 2, t: "hello" });
  check(
    "malformed channel message dropped by the validator",
    received.length === 1,
  );

  // Another hoster tab's outbound traffic must never become our stdin.
  fakeOs.postMessage({ v: 1, t: "data", d: "reflected", via: "bc-hoster" });
  check("hoster-stamped channel traffic ignored", received.length === 1);

  fakeOs.postMessage({ v: 1, t: "data", d: "ls\r" });
  check("plain OS data accepted", received.length === 2);

  transport.send({ v: 1, t: "ready" });
  check(
    "send posts to channel with protocol fields intact",
    osReceived.length === 1 &&
      osReceived[0].v === 1 &&
      osReceived[0].t === "ready",
  );
  check("outbound carries the hoster marker", osReceived[0].via === "bc-hoster");
  check("no self-delivery of own sends", received.length === 2);

  const received2: IncomingMessage[] = [];
  const transport2 = new BroadcastChannelTransport(BROADCAST_CHANNEL_NAME);
  transport2.onMessage((m) => received2.push(m));
  transport.send({ v: 1, t: "data", d: "engine output" });
  check(
    "second hoster tab ignores first tab's output",
    received2.length === 0 && osReceived.length === 2,
  );
}

// ---------- CompositeTransport ----------

function compositeTransportTests(): void {
  const sentA: OutgoingMessage[] = [];
  const sentB: OutgoingMessage[] = [];
  const childHandlers: Array<(msg: IncomingMessage) => void> = [];
  const childA: BridgeTransport = {
    send: (m) => sentA.push(m),
    onMessage: (h) => childHandlers.push(h),
    sendFs: () => {},
    onFsMessage: () => {},
  };
  const childB: BridgeTransport = {
    send: (m) => sentB.push(m),
    onMessage: (h) => childHandlers.push(h),
    sendFs: () => {},
    onFsMessage: () => {},
  };

  const composite = new CompositeTransport([childA, childB]);
  const received: IncomingMessage[] = [];
  composite.onMessage((m) => received.push(m));
  check(
    "composite registers the handler on every child",
    childHandlers.length === 2,
  );

  childHandlers[0]?.({ v: 1, t: "hello" });
  childHandlers[1]?.({ v: 1, t: "data", d: "x" });
  check(
    "input from either child reaches the single handler",
    received.length === 2,
  );

  composite.send({ v: 1, t: "ready" });
  check(
    "output fans out to every child exactly once",
    sentA.length === 1 && sentB.length === 1,
  );
}

// ---------- End-to-end: one bridge over CompositeTransport([BC]) ----------

async function tabModeIntegrationTest(): Promise<void> {
  setGlobalBroadcastChannel(FakeBroadcastChannel);
  FakeBroadcastChannel.reset();

  const written: string[] = [];
  const bridge = new HosterBridge(
    new CompositeTransport([
      new BroadcastChannelTransport(BROADCAST_CHANNEL_NAME),
    ]),
    { write: (d) => written.push(d), resize() {} },
  );

  const os = new FakeBroadcastChannel(BROADCAST_CHANNEL_NAME);
  const osReceived: Array<Record<string, unknown>> = [];
  os.addEventListener("message", (ev) =>
    osReceived.push(ev.data as Record<string, unknown>),
  );

  os.postMessage({ v: 1, t: "hello" });
  check("tab mode: no ready before engine is up", osReceived.length === 0);

  bridge.acceptOutput(enc.encode("user@dragon86:~$ "));
  bridge.markEngineReady();
  check(
    "tab mode: ready then backlog over the channel",
    osReceived.map((m) => m.t).join(",") === "ready,data",
  );

  os.postMessage({ v: 1, t: "data", d: "pwd\r" });
  check(
    "tab mode: OS keystrokes reach engine stdin",
    written.join("") === "pwd\r",
  );

  bridge.acceptExit(0);
  check("tab mode: exit posted to the channel", osReceived.at(-1)?.t === "exit");
}

// ---------- fs1: caps + v2 message parsing ----------

function fsProtocolTests(): void {
  const helloCaps = parseIncomingMessage({
    v: 1,
    t: "hello",
    caps: ["fs1"],
  });
  check(
    "hello caps parse",
    helloCaps?.t === "hello" &&
      JSON.stringify(helloCaps.caps) === '["fs1"]',
  );
  check(
    "hello without caps has no caps field",
    parseIncomingMessage({ v: 1, t: "hello" })?.t === "hello" &&
      !("caps" in (parseIncomingMessage({ v: 1, t: "hello" }) ?? {})),
  );
  const dirtyCaps = parseIncomingMessage({
    v: 1,
    t: "hello",
    caps: [1, "fs1", "fs1", "x".repeat(40), null],
  });
  check(
    "caps sanitized (strings only, deduped, length-capped)",
    dirtyCaps?.t === "hello" &&
      JSON.stringify(dirtyCaps.caps) === '["fs1"]',
  );
  const stringCaps = parseIncomingMessage({ v: 1, t: "hello", caps: "fs1" });
  check(
    "non-array caps ignored",
    stringCaps?.t === "hello" && stringCaps.caps === undefined,
  );

  const res = parseFsResponse({
    v: FS_PROTOCOL_VERSION,
    t: "fs-res",
    id: 7,
    ok: true,
    tree: [{ path: "a.txt", isDir: false, size: 3, mtime: 42 }],
  });
  check("fs-res parses", res?.tree?.[0]?.path === "a.txt");
  check(
    "fs-res wrong version rejected",
    parseFsResponse({ v: 1, t: "fs-res", id: 1, ok: true }) === null,
  );
  check(
    "fs-res malformed entries rejected wholesale",
    parseFsResponse({
      v: 2,
      t: "fs-res",
      id: 1,
      ok: true,
      entries: [{ name: 5, isDir: false, size: 1, mtime: 1 }],
    }) === null,
  );
  check(
    "fs-res array data rejected (must be bytes)",
    parseFsResponse({ v: 2, t: "fs-res", id: 1, ok: true, data: [1, 2] }) ===
      null,
  );
  const bufRes = parseFsResponse({
    v: 2,
    t: "fs-res",
    id: 1,
    ok: true,
    data: new Uint8Array([9]).buffer,
  });
  check(
    "fs-res ArrayBuffer data wrapped as Uint8Array",
    bufRes?.data instanceof Uint8Array && bufRes.data[0] === 9,
  );

  check(
    "fs-req parses",
    parseFsRequest({ v: 2, t: "fs-req", id: 3, op: "tree", path: "/" })
      ?.op === "tree",
  );
  check(
    "fs-req unknown op rejected",
    parseFsRequest({ v: 2, t: "fs-req", id: 3, op: "hack" }) === null,
  );
}

// ---------- fs1: bridge ready/caps choreography ----------

function bridgeCapsTests(): void {
  const transport = new LoopbackTransport();
  const peerMsgs: OutgoingMessage[] = [];
  const capsCalls: string[][] = [];
  let live = false;
  transport.onPeerMessage((m) => peerMsgs.push(m));
  const bridge = new HosterBridge(
    transport,
    { write() {}, resize() {} },
    {
      onPeerCaps: (caps) => capsCalls.push(caps),
      getReadyCaps: () => (live ? [FS_CAP, "not-offered"] : []),
    },
  );

  bridge.refreshReady();
  check("refreshReady before handshake is a no-op", peerMsgs.length === 0);

  transport.sendToHoster({ v: 1, t: "hello", caps: [FS_CAP, "x9"] });
  check(
    "onPeerCaps fired with hello caps",
    capsCalls.length === 1 && capsCalls[0]?.includes(FS_CAP) === true,
  );
  bridge.markEngineReady();
  const firstReady = peerMsgs.find((m) => m.t === "ready");
  check(
    "ready omits caps while fs not live (v1 wire unchanged)",
    firstReady?.t === "ready" && !("caps" in firstReady),
  );

  live = true;
  bridge.refreshReady();
  const lastReady = peerMsgs.filter((m) => m.t === "ready").at(-1);
  check(
    "re-announced ready carries intersection of caps",
    lastReady?.t === "ready" &&
      JSON.stringify(lastReady.caps) === `["${FS_CAP}"]`,
  );

  transport.sendToHoster({ v: 1, t: "hello", caps: [FS_CAP, "x9"] });
  check(
    "onPeerCaps not re-fired for unchanged caps",
    capsCalls.length === 1,
  );
}

// ---------- fs1: FsClient ----------

async function fsClientTests(): Promise<void> {
  const sent: FsRequestMessage[] = [];
  const holder: { h: ((m: FsResponseMessage) => void) | null } = { h: null };
  const transport: BridgeTransport = {
    send() {},
    onMessage() {},
    sendFs: (m) => sent.push(m),
    onFsMessage: (h) => {
      holder.h = h;
    },
  };
  const respond = (res: FsResponseMessage) => holder.h?.(res);
  const client = new FsClient(transport);

  const treeP = client.tree();
  const readP = client.read("x.txt");
  check(
    "requests carry op + path + ids",
    sent.length === 2 &&
      sent[0]?.op === "tree" &&
      sent[1]?.op === "read" &&
      sent[0]?.id !== sent[1]?.id,
  );
  // Answer out of order — correlation is by id alone.
  respond({
    v: 2,
    t: "fs-res",
    id: sent[1]!.id,
    ok: true,
    data: enc.encode("hi"),
  });
  respond({ v: 2, t: "fs-res", id: sent[0]!.id, ok: true, tree: [] });
  check("out-of-order responses resolve correctly", 
    (await treeP).length === 0 &&
      new TextDecoder().decode(await readP) === "hi",
  );

  const errP = client.stat("nope");
  respond({ v: 2, t: "fs-res", id: sent.at(-1)!.id, ok: false, error: "ENOENT" });
  const err = await errP.catch((e: unknown) => e);
  check(
    "ok:false rejects with FsError code",
    err instanceof FsError && err.code === "ENOENT",
  );

  const impatient = new FsClient(transport, 15);
  const timeoutErr = await impatient.tree().catch((e: unknown) => e);
  check(
    "unanswered request times out",
    timeoutErr instanceof FsError && timeoutErr.code === "ETIMEOUT",
  );
}

// ---------- fs1: pure three-way diff ----------

function diffTests(): void {
  const F = (size: number, mtime: number): FileState => ({
    isDir: false,
    size,
    mtime,
  });
  const D = (mtime = 0): FileState => ({ isDir: true, size: 0, mtime });
  const map = (o: Record<string, FileState>): StateMap => new Map(Object.entries(o));
  const known = (g: FileState | null, o: FileState | null): KnownMap =>
    new Map([["a", { guest: g, os: o }]]);

  let d = diffStates(new Map(), map({ a: F(3, 100) }), new Map());
  check("new guest file → write to OS", d.toOs[0]?.kind === "write");

  d = diffStates(known(F(3, 100), F(3, 900)), new Map(), map({ a: F(3, 900) }));
  check("guest delete → remove on OS", d.toOs[0]?.kind === "remove");

  d = diffStates(new Map(), new Map(), map({ a: F(3, 100) }));
  check("new OS file → put to guest", d.toGuest[0]?.kind === "put");

  d = diffStates(known(D(1), D(1)), map({ a: D(999) }), map({ a: D(1) }));
  check(
    "directory mtime churn is not a change",
    d.toOs.length === 0 && d.toGuest.length === 0,
  );

  d = diffStates(known(F(3, 100), F(3, 100)), new Map(), new Map());
  check(
    "deleted on both sides → converged",
    d.converged.get("a")?.guest === null && d.toOs.length === 0,
  );

  d = diffStates(
    known(F(3, 100), F(3, 100)),
    map({ a: F(4, 200) }),
    map({ a: F(5, 150) }),
  );
  check(
    "both edited, guest newer → guest wins",
    d.conflicts.includes("a") && d.toOs[0]?.kind === "write",
  );

  d = diffStates(
    known(F(3, 100), F(3, 100)),
    map({ a: F(4, 200) }),
    new Map(),
  );
  check(
    "edit vs delete → edit wins",
    d.toOs[0]?.kind === "write" && d.toGuest.length === 0,
  );

  d = diffStates(
    known(F(3, 100), F(3, 100)),
    map({ a: F(3, 200) }),
    map({ a: F(3, 150) }),
  );
  check(
    "both edited same size → byte-compare candidate",
    d.compareCandidates.includes("a") && d.toOs.length === 0,
  );

  d = diffStates(new Map(), map({ big: F(20, 1) }), new Map(), 10);
  check(
    "oversize file is skipped, not synced",
    d.oversize.includes("big") && d.toOs.length === 0,
  );

  const renameKnown: KnownMap = new Map([
    ["a", { guest: F(3, 100), os: F(3, 100) }],
  ]);
  d = diffStates(renameKnown, map({ b: F(3, 100) }), map({ a: F(3, 100) }));
  check(
    "guest mv detected as rename (no re-upload)",
    d.toOs.length === 1 &&
      d.toOs[0]?.kind === "rename" &&
      d.toOs[0].from === "a" &&
      d.toOs[0].to === "b",
  );
  d = diffStates(renameKnown, map({ a: F(3, 100) }), map({ b: F(3, 100) }));
  check(
    "OS mv detected as rename",
    d.toGuest.length === 1 && d.toGuest[0]?.kind === "rename",
  );

  check(
    "reserved/invalid paths are not syncable",
    !isSyncablePath(".dragon86-manifest.json") &&
      !isSyncablePath(".dragon86-agent.log") &&
      !isSyncablePath("x.tmp-agent") &&
      !isSyncablePath("../escape") &&
      !isSyncablePath("/abs") &&
      isSyncablePath("docs/note.txt"),
  );

  const manifestBytes = enc.encode(
    JSON.stringify({
      v: 1,
      bootId: "b1",
      cycle: 4,
      appliedPlan: 2,
      generatedAtMs: 1,
      lastError: null,
      entries: [{ path: "a.txt", isDir: false, size: 3, mtimeMs: 77 }],
    }),
  );
  const manifest = parseManifest(manifestBytes);
  check(
    "manifest parses",
    manifest?.appliedPlan === 2 &&
      manifest.states.get("a.txt")?.mtime === 77,
  );
  check(
    "corrupt manifest → null",
    parseManifest(enc.encode("{nope")) === null,
  );
}

// ---------- fs1: end-to-end sync over loopback with fake OS + fake agent ----------

async function fsSyncIntegrationTest(): Promise<void> {
  const dec = new TextDecoder();
  const transport = new LoopbackTransport();

  // Fake guest shared folder + inbox (what CheerpXEngine would back with
  // the IDB/Data devices), plus a simulated in-guest agent.
  const guestFiles = new Map<string, { data: Uint8Array; mtime: number }>();
  const guestDirs = new Set<string>();
  const inbox = new Map<string, Uint8Array>();
  const agent = { cycle: 0, appliedPlan: 0 };
  const ensureGuestDirs = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) guestDirs.add(parts.slice(0, i).join("/"));
  };
  const hooks: SharedFolderHooks = {
    readSharedFile: async (rel) => {
      if (rel === ".dragon86-manifest.json") {
        const entries = [
          ...[...guestDirs].map((path) => ({
            path,
            isDir: true,
            size: 0,
            mtimeMs: 0,
          })),
          ...[...guestFiles].map(([path, f]) => ({
            path,
            isDir: false,
            size: f.data.length,
            mtimeMs: f.mtime,
          })),
        ].sort((x, y) => x.path.localeCompare(y.path));
        return enc.encode(
          JSON.stringify({
            v: 1,
            bootId: "testboot",
            cycle: agent.cycle,
            appliedPlan: agent.appliedPlan,
            generatedAtMs: Date.now(),
            lastError: null,
            entries,
          }),
        );
      }
      return guestFiles.get(rel)?.data ?? null;
    },
    stageInboxFile: async (name, data) => {
      inbox.set(name, typeof data === "string" ? enc.encode(data) : data);
    },
  };
  const runAgent = () => {
    for (const [name, bytes] of inbox) {
      const m = /^plan-(\d+)\.json$/.exec(name);
      if (m === null) continue;
      const seq = Number(m[1]);
      if (seq <= agent.appliedPlan) continue;
      const plan = JSON.parse(dec.decode(bytes)) as {
        ops: Array<Record<string, unknown>>;
      };
      for (const op of plan.ops) {
        const path = String(op.path);
        if (op.op === "put") {
          ensureGuestDirs(path);
          guestFiles.set(path, {
            data: inbox.get(String(op.staged)) ?? new Uint8Array(),
            mtime: Number(op.mtimeMs),
          });
        } else if (op.op === "mkdir") {
          ensureGuestDirs(path);
          guestDirs.add(path);
        } else if (op.op === "remove") {
          guestFiles.delete(path);
          guestDirs.delete(path);
        } else if (op.op === "rename") {
          const file = guestFiles.get(path);
          if (file !== undefined) {
            guestFiles.delete(path);
            guestFiles.set(String(op.to), file);
          }
        }
      }
      agent.appliedPlan = seq;
    }
    agent.cycle++;
  };

  // Fake OS file server (in-memory), answering on the loopback peer side.
  const osFiles = new Map<string, { data: Uint8Array; mtime: number }>();
  const osDirs = new Set<string>();
  let osClock = 100_000;
  transport.onPeerFsMessage((req) => {
    const base = { v: FS_PROTOCOL_VERSION, t: "fs-res" as const, id: req.id };
    const path = (req.path ?? "/").replace(/^\/+/, "");
    const statOf = (p: string) =>
      osDirs.has(p)
        ? { isDir: true, size: 0, mtime: 0 }
        : {
            isDir: false,
            size: osFiles.get(p)?.data.length ?? 0,
            mtime: osFiles.get(p)?.mtime ?? 0,
          };
    switch (req.op) {
      case "tree":
        transport.sendFsToHoster({
          ...base,
          ok: true,
          tree: [
            ...[...osDirs].map((p) => ({ path: p, ...statOf(p) })),
            ...[...osFiles.keys()].map((p) => ({ path: p, ...statOf(p) })),
          ],
        });
        break;
      case "read":
        transport.sendFsToHoster(
          osFiles.has(path)
            ? { ...base, ok: true, data: osFiles.get(path)!.data }
            : { ...base, ok: false, error: "ENOENT" },
        );
        break;
      case "write": {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) osDirs.add(parts.slice(0, i).join("/"));
        osFiles.set(path, { data: req.data ?? new Uint8Array(), mtime: ++osClock });
        transport.sendFsToHoster({ ...base, ok: true, stat: statOf(path) });
        break;
      }
      case "mkdir":
        osDirs.add(path);
        transport.sendFsToHoster({ ...base, ok: true, stat: statOf(path) });
        break;
      case "remove":
        osFiles.delete(path);
        osDirs.delete(path);
        transport.sendFsToHoster({ ...base, ok: true });
        break;
      case "rename": {
        const file = osFiles.get(path);
        if (file !== undefined && req.to !== undefined) {
          osFiles.delete(path);
          osFiles.set(req.to, file);
        }
        transport.sendFsToHoster({
          ...base,
          ok: true,
          stat: statOf(req.to ?? path),
        });
        break;
      }
      case "stat":
        transport.sendFsToHoster(
          osFiles.has(path) || osDirs.has(path)
            ? { ...base, ok: true, stat: statOf(path) }
            : { ...base, ok: false, error: "ENOENT" },
        );
        break;
      case "list":
        transport.sendFsToHoster({ ...base, ok: true, entries: [] });
        break;
    }
  });

  osFiles.set("osfile.txt", { data: enc.encode("from os"), mtime: 1111 });
  guestFiles.set("guestfile.txt", { data: enc.encode("from guest"), mtime: 2222 });

  const liveFlags: boolean[] = [];
  const sync = new SharedFolderSync(transport, hooks, {
    onLiveChange: (live) => liveFlags.push(live),
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await sync.syncOnce();
      await sleep(2);
    }
  };

  sync.setPeerCaps([FS_CAP]);
  await settle();
  check(
    "sync: guest file pushed to OS",
    dec.decode(osFiles.get("guestfile.txt")?.data ?? new Uint8Array()) ===
      "from guest",
  );
  check(
    "sync: OS→guest plan staged but unacked → not live",
    sync.live === false &&
      [...inbox.keys()].some((k) => k.startsWith("plan-")),
  );

  runAgent();
  await settle();
  check(
    "sync: OS file applied into guest",
    dec.decode(guestFiles.get("osfile.txt")?.data ?? new Uint8Array()) ===
      "from os",
  );
  check(
    "sync: live after ack + clean cycle",
    sync.live === true && liveFlags.includes(true),
  );

  guestFiles.delete("guestfile.txt");
  agent.cycle++;
  await settle();
  check("sync: guest delete propagated to OS", !osFiles.has("guestfile.txt"));

  osFiles.set("osfile.txt", { data: enc.encode("os v2"), mtime: ++osClock });
  await settle();
  runAgent();
  await settle();
  check(
    "sync: OS edit propagated to guest",
    dec.decode(guestFiles.get("osfile.txt")?.data ?? new Uint8Array()) ===
      "os v2",
  );

  sync.stop();
}

await bridgeTests();
postMessageTests();
broadcastChannelUnavailableTests();
broadcastChannelTests();
compositeTransportTests();
await tabModeIntegrationTest();
fsProtocolTests();
bridgeCapsTests();
await fsClientTests();
diffTests();
await fsSyncIntegrationTest();
console.log(`\nAll ${passed} bridge protocol checks passed.`);
