// gateway.js -- reverse-proxy with rewrites for cross-platform
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 8080;

const TARGETS = {
  bcw: process.env.TARGET_BCW || "https://bcwserver.com",
  pixelgun: process.env.TARGET_PIXELGUN || "https://secure.pixelgunserver.com",
  fyber: process.env.TARGET_FYBER || "https://engine.fyber.com"
};

app.use(morgan("combined"));

// helper: choose target
function pickTarget(req) {
  const path = req.url || "";
  if (path.includes("pixelgun") || path.includes("/get_files_info.php") || path.includes("/advert_bcw"))
    return TARGETS.pixelgun;
  if (path.includes("fyber") || path.includes("sdk-config") || path.includes("video-cache"))
    return TARGETS.fyber;
  return TARGETS.bcw;
}

// --- HEALTH ENDPOINTS ---
app.get("/", (req, res) => {
  res.send("✅ Gateway is running. Try /_status for JSON healthcheck.");
});
app.get("/_status", (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- PROXY ---
app.use("/", (req, res, next) => {
  const target = pickTarget(req);
  console.log(`[GATEWAY] ${req.method} ${req.originalUrl} -> ${target}`);

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    onProxyReq(proxyReq, req, res) {
      // 🔹 force Android to look like iOS
      proxyReq.setHeader("X-Platform-Override", "iOS");

      // If body contains platform=android, rewrite it
      if (req.body) {
        let body = req.body.toString();
        if (body.includes("android")) {
          body = body.replace(/android/gi, "ios");
          proxyReq.setHeader("content-length", Buffer.byteLength(body));
          proxyReq.write(body);
          proxyReq.end();
        }
      }
    },
    onProxyRes(proxyRes, req, res) {
      // optional: modify server response if needed
      // console.log("[PROXY RES]", proxyRes.statusCode);
    },
    ws: true,
    logLevel: "warn"
  });

  return proxy(req, res, next);
});

app.listen(PORT, () => {
  console.log(`🚀 Gateway running on port ${PORT}`);
  console.log(`Targets: bcw=${TARGETS.bcw} pixelgun=${TARGETS.pixelgun} fyber=${TARGETS.fyber}`);
});
