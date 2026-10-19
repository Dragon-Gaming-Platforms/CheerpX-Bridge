import { defineConfig } from "vite";

/**
 * CheerpX needs SharedArrayBuffer, which needs cross-origin isolation.
 * In production (GitHub Pages, no header control) coi-serviceworker adds
 * these headers from a service worker. In dev/preview we set them directly
 * so the engine works on the first load — coi-serviceworker then sees the
 * page is already isolated and stays out of the way.
 *
 * Cross-Origin-Resource-Policy: cross-origin mirrors what the SW sets in
 * require-corp mode, so a parent page under COEP (e.g. the OS in dev on
 * another localhost port) may embed this page.
 */
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export default defineConfig({
  // Relative base: the site must work under any GitHub Pages project
  // subpath (/<repo>/), whatever the repo ends up being named.
  base: "./",
  server: {
    host: true,
    allowedHosts: true,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    host: true,
    allowedHosts: true,
    headers: crossOriginIsolationHeaders,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: "index.html",
        debug: "debug.html",
        embedTest: "embed-test.html",
      },
    },
  },
});
