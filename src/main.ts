import { PostMessageTransport } from "./bridge/hosterBridge";
import { startHoster } from "./hoster";
import { StatusView } from "./status";

/**
 * index.html — the headless engine page.
 *
 * Boots CheerpX + bash and serves the OS over the postMessage bridge.
 * Normally embedded as a hidden 1×1 iframe by Dragon86; the status view
 * below is only for humans who open this URL directly.
 */
const statusEl = document.getElementById("status");
if (statusEl !== null) {
  const status = new StatusView(statusEl);
  const transport = new PostMessageTransport((origin) => {
    status.setPeer(`hello received from ${origin}`);
  });
  startHoster(transport, {
    onState: (state, detail) => status.setEngineState(state, detail),
    onPeerReady: () => status.setPeer("connected — ready announced ✓"),
  });
}
