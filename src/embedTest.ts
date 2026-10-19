import { PROTOCOL_VERSION } from "./config";

/**
 * embed-test.html — a minimal stand-in for the Dragon86 OS parent page.
 *
 * Mirrors src/bridge/hoster.ts in the OS repo: hidden 1×1 iframe, hello
 * repeated every 400ms after (each) iframe load, 6s timeout, identical
 * message shapes sent with targetOrigin "*". Unlike the OS it keeps
 * listening after the timeout so you can watch a slow first boot finish.
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
const outEl = el("out");
const logEl = el("log");
const cmdEl = el<HTMLInputElement>("cmd");
const colsEl = el<HTMLInputElement>("cols");
const rowsEl = el<HTMLInputElement>("rows");

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
let connectStartedAt = 0;

function post(msg: unknown): void {
  log("os → hoster ", msg);
  iframe?.contentWindow?.postMessage(msg, "*"); // exactly like the OS
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
  connectStartedAt = performance.now();
  handshakeEl.className = "";
  handshakeEl.textContent = "handshake: waiting for ready…";

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
    const sendHello = () => post({ v: PROTOCOL_VERSION, t: "hello" });
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
  const msg = ev.data as
    | { v?: unknown; t?: unknown; d?: unknown; code?: unknown }
    | null;
  if (msg === null || msg.v !== PROTOCOL_VERSION) return;
  log("hoster → os ", msg);
  switch (msg.t) {
    case "ready": {
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

connect();
