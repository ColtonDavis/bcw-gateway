// gateway.js -- small, robust reverse-proxy for Render
// Deploy on Render: Render sets PORT via env var. This uses express + http-proxy-middleware.
//
// Behavior:
// - Listens on process.env.PORT (default 8080 locally)
// - Proxies requests to the official upstreams (bcwserver, secure.pixelgunserver, engine.fyber)
// - Logs requests and responses for easy debugging
// - Can be extended to rewrite request/response bodies (commented spots included)

import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 8080;

// Upstream targets (change if you want a different default)
const TARGETS = {
  bcw: process.env.TARGET_BCW || "https://bcwserver.com",
  pixelgun: process.env.TARGET_PIXELGUN || "https://secure.pixelgunserver.com",
  fyber: process.env.TARGET_FYBER || "https://engine.fyber.com"
};

// Logging http requests
app.use(morgan("combined"));

// Helper: choose target based on incoming Host header or path heuristics
function pickTarget(req) {
  const host = (req.headers.host || "").toLowerCase();
  const path = req.url || "";

  if (host.includes("pixelgun") || path.includes("/get_files_info.php") || path.includes("/advert_bcw")) {
    return TARGETS.pixelgun;
  }
  if (host.includes("fyber") || path.includes("sdk-config") || path.includes("video-cache")) {
    return TARGETS.fyber;
  }
  // default to bcwserver for blockcity endpoints
  return TARGETS.bcw;
}

// Proxy middleware (catch-all)
app.use("/", (req, res, next) => {
  const target = pickTarget(req);
  // debug log
  console.log(`[GATEWAY] ${req.method} ${req.originalUrl} -> ${target}`);

  // Build proxy with optional hooks (e.g. to rewrite request body or headers)
  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    onProxyReq(proxyReq, req, res) {
      // Example header overrides you can enable if needed:
      // proxyReq.setHeader("X-Platform-Override", "Android");
      // proxyReq.setHeader("Authorization", process.env.ANDROID_AUTH || proxyReq.getHeader("Authorization"));

      // if you want to rewrite the POST body you must buffer it here (advanced)
      // See: https://github.com/chimurai/http-proxy-middleware#proxy-context-middleware
    },
    onProxyRes(proxyRes, req, res) {
      // Optionally inspect or modify response here. Keep small to avoid big overhead.
      // console.log("[PROXY RES STATUS]", proxyRes.statusCode);
    },
    ws: true,
    logLevel: "warn"
  });

  return proxy(req, res, next);
});

// health
app.get("/_status", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`Gateway running on port ${PORT}`);
  console.log(`Targets: bcw=${TARGETS.bcw} pixelgun=${TARGETS.pixelgun} fyber=${TARGETS.fyber}`);
});
