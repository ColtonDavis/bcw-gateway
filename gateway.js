// gateway.js -- reverse-proxy with mocks, android->ios normalization, and response logging
import express from "express";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";
import morgan from "morgan";
import url from "url";

const app = express();
const PORT = process.env.PORT || 8080;

// Upstream targets (change if you want different defaults)
const TARGETS = {
  bcw: process.env.TARGET_BCW || "https://bcwserver.com",
  pixelgun: process.env.TARGET_PIXELGUN || "https://secure.pixelgunserver.com",
  fyber: process.env.TARGET_FYBER || "https://engine.fyber.com"
};

// small body size limit for buffering (adjust if needed)
app.use(express.raw({ type: '*/*', limit: '2mb' }));
app.use(morgan("combined"));

// --- Health and root endpoints (must come BEFORE proxy) ---
app.get("/", (req, res) => {
  res.send("✅ Gateway is running. Try /_status for JSON healthcheck.");
});
app.get("/_status", (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Lightweight mock for /bcw3d to avoid upstream 404 crashing the client ---
app.get("/bcw3d", (req, res) => {
  console.log("[GATEWAY MOCK] /bcw3d called", { query: req.query, ua: req.headers["user-agent"] });

  const resp = {
    status: "ok",
    message: "mock lobby",
    version: "1.0",
    lobby: {
      rooms: [],
      players_online: 0
    },
    assets: [],
    config: {}
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(JSON.stringify(resp));
});

// --- helper: choose target based on incoming Host header or path heuristics ---
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

// Helper to determine if request likely came from Android client (simple heuristic)
function isLikelyAndroid(req) {
  const ua = (req.headers['user-agent'] || "").toLowerCase();
  const orig = (req.originalUrl || "").toLowerCase();
  if (ua.includes("android") || orig.includes("platform=android") || orig.includes("_android.json")) return true;
  return false;
}

// --- Catch-all proxy ---
app.use("/", (req, res, next) => {
  const target = pickTarget(req);
  console.log(`[GATEWAY] ${req.method} ${req.originalUrl} -> ${target}  (UA:${req.headers['user-agent'] || ''})`);

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    selfHandleResponse: true, // so we can inspect/modify response
    onProxyReq(proxyReq, req, res) {
      try {
        // Tag for logs / filtering
        proxyReq.setHeader("X-Gateway-Tag", "ybcw-gate");

        // Normalize User-Agent + platform headers to look like iOS (helps backend accept requests)
        // This is conservative — backend often requires iOS params/casing.
        proxyReq.setHeader("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");
        proxyReq.setHeader("X-Platform-Override", "iOS");

        // Ensure query string includes canonical iOS params and signature fallback
        try {
          const parsed = url.parse(proxyReq.path || req.url, true);
          // canonical iOS keys
          parsed.query.platform = 'ios';
          parsed.query.os_name = 'iPhone OS';
          parsed.query.client = 'ios';
          if (!parsed.query.phone_model) parsed.query.phone_model = 'iPad15,7';
          if (!parsed.query.manufacturer) parsed.query.manufacturer = 'Apple Inc.';
          // signature fallback if missing
          parsed.query.signature = parsed.query.signature ? parsed.query.signature : 'ANDROID_BYPASS_SIGNATURE';
          proxyReq.path = url.format({ pathname: parsed.pathname, query: parsed.query });
        } catch (e) {
          // ignore query rewrite failures
          console.warn("[GATEWAY] query rewrite failed", e && e.message);
        }

        // If request had a body (we buffered via express.raw), rewrite "android" -> "ios" inside and forward it
        if (req.body && req.body.length) {
          let bodyStr;
          try { bodyStr = req.body.toString('utf8'); } catch { bodyStr = null; }
          if (bodyStr) {
            if (bodyStr.toLowerCase().includes("android")) {
              bodyStr = bodyStr.replace(/android/gi, "ios");
            }
            // set content-length and write the possibly-rewritten body to the proxied request
            proxyReq.setHeader("content-length", Buffer.byteLength(bodyStr, 'utf8'));
            proxyReq.write(Buffer.from(bodyStr, 'utf8'));
            proxyReq.end();
          }
        }
      } catch (err) {
        console.warn("[GATEWAY] onProxyReq error:", err && err.message);
      }
    },

    // Intercept responses so we can log status/headers and rewrite iOS -> android names for Android clients.
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      try {
        const isAndroid = isLikelyAndroid(req);
        const body = responseBuffer ? responseBuffer.toString("utf8") : "";

        // Log summary: status + headers + snippet of body
        console.log(`\n[PROXY RES] ${req.method} ${req.originalUrl}`);
        console.log("Status:", proxyRes.statusCode);
        console.log("Headers:", proxyRes.headers);
        if (body && body.length) {
          console.log("Body snippet:", body.substring(0, 1000));
        } else {
          console.log("Body: <empty or binary>");
        }

        // If the client was Android, rewrite common ios filenames back to android so the client finds expected assets
        if (isAndroid && body && body.length) {
          let rewritten = body
            .replace(/_ios\.json/g, "_android.json")
            // some backends use "ios" in other resource names — add more rules as needed
            .replace(/iphone os/gi, "Android")
            .replace(/ipad/gi, "Pixel 6");

          // If content-type is JSON, return rewritten JSON.
          if ((proxyRes.headers['content-type'] || "").includes("application/json") || proxyRes.headers['content-type']?.includes("text/html")) {
            return Buffer.from(rewritten, "utf8");
          }
        }

        // by default return original responseBuffer
        return responseBuffer;
      } catch (err) {
        console.warn("[GATEWAY] onProxyRes error:", err && err.message);
        return responseBuffer;
      }
    }),

    ws: true,
    logLevel: "warn"
  });

  return proxy(req, res, next);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Gateway running on port ${PORT}`);
  console.log(`Targets: bcw=${TARGETS.bcw} pixelgun=${TARGETS.pixelgun} fyber=${TARGETS.fyber}`);
});
