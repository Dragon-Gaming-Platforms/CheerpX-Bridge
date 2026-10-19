import { LoopbackTransport } from "./bridge/hosterBridge";
import type { OutgoingMessage } from "./bridge/protocol";
import { PROTOCOL_VERSION } from "./config";
import { startHoster } from "./hoster";
import { StatusView } from "./status";

/**
 * debug.html — same-page test harness. The engine runs here; the textarea
 * plays the OS and speaks bridge protocol v1 through LoopbackTransport
 * (same validator + bridge code as production, minus real postMessage —
 * embed-test.html covers that path).
 *
 * Deliberately rough and NOT a terminal emulator: bytes are shown raw
 * (ESC displayed as ␛), echo comes from the PTY itself. Terminal
 * rendering belongs to the OS.
 */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

const status = new StatusView(el("status"));
status.setPeer("loopback (same page)");

const consoleEl = el<HTMLTextAreaElement>("console");
const logEl = el("log");
const colsEl = el<HTMLInputElement>("cols");
const rowsEl = el<HTMLInputElement>("rows");

function log(direction: string, msg: unknown): void {
  let shown = JSON.stringify(msg);
  if (shown !== undefined && shown.length > 220) {
    shown = `${shown.slice(0, 220)}… (${shown.length} chars)`;
  }
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()} ${direction} ${shown}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function appendConsole(text: string): void {
  // Display-only transform so escape sequences are visible instead of
  // silently swallowing their ESC byte. The wire stream is untouched.
  consoleEl.value += text.replace(/\x1b/g, "␛");
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

const transport = new LoopbackTransport();

transport.onPeerMessage((msg: OutgoingMessage) => {
  log("hoster → os ", msg);
  switch (msg.t) {
    case "ready":
      status.setPeer("loopback — ready received ✓");
      consoleEl.focus();
      break;
    case "data":
      appendConsole(msg.d);
      break;
    case "exit":
      appendConsole(`\r\n[process exited: ${msg.code} — reload page to reboot]\r\n`);
      break;
  }
});

startHoster(transport, {
  onState: (state, detail) => status.setEngineState(state, detail),
});

function toHoster(msg: unknown): void {
  log("os → hoster ", msg);
  transport.sendToHoster(msg);
}

function sendHello(): void {
  toHoster({ v: PROTOCOL_VERSION, t: "hello" });
}
sendHello(); // once is enough on loopback; the real OS repeats every 400ms

function sendData(d: string): void {
  toHoster({ v: PROTOCOL_VERSION, t: "data", d });
}

function sendResize(): void {
  const cols = Number.parseInt(colsEl.value, 10);
  const rows = Number.parseInt(rowsEl.value, 10);
  if (Number.isFinite(cols) && Number.isFinite(rows)) {
    consoleEl.cols = cols; // rough visual parity with the PTY size
    toHoster({ v: PROTOCOL_VERSION, t: "resize", cols, rows });
  }
}

/** Translate a keydown into the byte sequence the PTY expects. */
function keyToData(ev: KeyboardEvent): string | null {
  if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) {
    // Let Ctrl+C mean "copy" when text is selected; otherwise ^C.
    if (
      (ev.key === "c" || ev.key === "C") &&
      consoleEl.selectionStart !== consoleEl.selectionEnd
    ) {
      return null;
    }
    const c = ev.key.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // ^@..^_
    if (ev.key === " ") return "\x00";
  }
  switch (ev.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    default:
      return ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey ? ev.key : null;
  }
}

consoleEl.addEventListener("keydown", (ev) => {
  const data = keyToData(ev);
  if (data !== null) {
    ev.preventDefault();
    sendData(data);
  }
});

consoleEl.addEventListener("paste", (ev) => {
  const text = ev.clipboardData?.getData("text") ?? "";
  if (text.length > 0) {
    ev.preventDefault();
    sendData(text);
  }
});

el("resize").addEventListener("click", sendResize);
el("hello").addEventListener("click", sendHello);
el("clear").addEventListener("click", () => {
  consoleEl.value = "";
  consoleEl.focus();
});
