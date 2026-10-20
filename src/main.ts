import {
  BroadcastChannelTransport,
  CompositeTransport,
  PostMessageTransport,
} from "./bridge/hosterBridge";
import { BROADCAST_CHANNEL_NAME } from "./config";
import { startHoster } from "./hoster";
import { StatusView } from "./status";

/**
 * index.html — the headless engine page.
 *
 * Boots CheerpX + bash and serves the OS over bridge protocol v1 (plus
 * the v2 "fs1" shared-folder ops when the OS advertises that capability)
 * through TWO transports at once (one bridge, one engine — see
 * CompositeTransport): embedded as a hidden 1×1 iframe (parent
 * postMessage), or opened as a separate top-level tab (BroadcastChannel;
 * window.opener is severed by this page's COOP, so direct postMessage is
 * unavailable in tab mode). The status view below is only for humans who
 * open this URL directly — there is deliberately no terminal UI here;
 * Dragon86 renders everything.
 */
const statusEl = document.getElementById("status");
if (statusEl !== null) {
  const status = new StatusView(statusEl);

  // Hellos are tracked per transport so each status line only claims
  // "ready announced" for a peer that actually said hello on it.
  let frameHello = false;
  let tabHello = false;

  const frameTransport = new PostMessageTransport((origin) => {
    frameHello = true;
    status.setPeer(`hello received from ${origin}`);
  });

  const tabTransport = new BroadcastChannelTransport(
    BROADCAST_CHANNEL_NAME,
    () => {
      tabHello = true;
      status.setTabPeer("hello received");
    },
  );
  status.setTabPeer(
    tabTransport.available
      ? `listening on channel "${BROADCAST_CHANNEL_NAME}"…`
      : "unavailable in this browser",
  );

  startHoster(new CompositeTransport([frameTransport, tabTransport]), {
    onState: (state, detail) => status.setEngineState(state, detail),
    onPeerReady: () => {
      if (frameHello) status.setPeer("connected — ready announced ✓");
      if (tabHello) status.setTabPeer("connected — ready announced ✓");
    },
    onSharedFolderState: (text) => status.setSharedFolder(text),
  });
}
