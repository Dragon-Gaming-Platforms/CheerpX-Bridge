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
  isOriginAllowed,
  parseIncomingMessage,
  type IncomingMessage,
  type OutgoingMessage,
} from "../src/bridge/protocol";
import { BROADCAST_CHANNEL_NAME } from "../src/config";

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
  };
  const childB: BridgeTransport = {
    send: (m) => sentB.push(m),
    onMessage: (h) => childHandlers.push(h),
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

await bridgeTests();
postMessageTests();
broadcastChannelUnavailableTests();
broadcastChannelTests();
compositeTransportTests();
await tabModeIntegrationTest();
console.log(`\nAll ${passed} bridge protocol checks passed.`);
