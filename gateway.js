// gateway.js -- reverse-proxy with health endpoints
// Works on Render (Render sets PORT in env var).

import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 8080;

// Upstream targets (change if you want different defaults)
const TARGETS = {
  bcw: process.env.TARGET_BCW || "https://bcwserver.com",
  pixelgun: process.env.TARGET_PIXELGUN || "https://secure.pixelgunserver.com",
  fyber: process.env.TARGET_FYBER || "https://engine.fyber.com"
};

// Logging
app.use(morgan("combined"));

// --- Health and root endpoints (must come BEFORE proxy) ---
app.get("/", (req, res) => {
  res.send("✅ Gateway is running. Try /_status for JSON healthcheck.");
});

app.get("/_status", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- Helper: choose target based on incoming request ---
function pickTarget(req) {
  const host = (req.headers.host || "").toLowerCase();
  const path = req.url || "";

  if (host.includes("pixelgun") || path.includes("/get_files_info.php") || path.includes("/advert_bcw")) {
    return TARGETS.pixelgun;
  }
  if (host.includes("fyber") || path.includes("sdk-config") || path.includes("video-cache")) {
    return TARGETS.fyber;
  }
  // default: block city upstream
  return TARGETS.bcw;
}

// --- Catch-all proxy ---
app.use("/", (req, res, next) => {
  const target = pickTarget(req);
  console.log(`[GATEWAY] ${req.method} ${req.originalUrl} -> ${target}`);

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    ws: true,
    logLevel: "warn",
    onProxyReq(proxyReq, req, res) {
      // 🔹 Here is where we can normalize Android → iOS params later
      // Example:
      // if (proxyReq.path.includes("platform=android")) {
      //   proxyReq.path = proxyReq.path.replace("platform=android", "platform=ios");
      // }
    },
    onProxyRes(proxyRes, req, res) {
      // 🔹 Place to rewrite response body if needed
      // e.g. change "_ios.json" -> "_android.json" for Android clients
    }
  });

  return proxy(req, res, next);
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Gateway running on port ${PORT}`);
  console.log(`Targets: bcw=${TARGETS.bcw} pixelgun=${TARGETS.pixelgun} fyber=${TARGETS.fyber}`);
});
