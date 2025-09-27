// gateway.js -- full-featured gateway with request/response store, dynamic mocks, and android->ios normalization
import express from "express";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";
import morgan from "morgan";
import url from "url";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = process.env.PORT || 8080;
const VERBOSE = process.env.GATEWAY_VERBOSE === "1";
const STORE_MAX = parseInt(process.env.GATEWAY_STORE_MAX || "200", 10);
const LOG_FILE = process.env.GATEWAY_LOG_FILE || path.resolve("./gateway_requests.log");

// Upstream targets (change via env when needed)
const TARGETS = {
  bcw: process.env.TARGET_BCW || "https://bcwserver.com",
  pixelgun: process.env.TARGET_PIXELGUN || "https://secure.pixelgunserver.com",
  fyber: process.env.TARGET_FYBER || "https://engine.fyber.com"
};

// buffer size for request bodies (adjust if client sends large payloads)
app.use(express.raw({ type: '*/*', limit: '2mb' }));
app.use(morgan("combined"));

// In-memory circular store of recent requests/responses
const recentRequests = [];
function pushRecent(entry) {
  recentRequests.push(entry);
  if (recentRequests.length > STORE_MAX) recentRequests.shift();
  if (VERBOSE) {
    try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n"); } catch(e) { /* ignore */ }
  }
}

// --- Health and root endpoints ---
app.get("/", (req, res) => {
  res.send("✅ Gateway is running. Try /_status for JSON healthcheck and /_admin/recent for recent requests.");
});
app.get("/_status", (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Dynamic mock store & admin API ---
// (useful to quickly make endpoints return canned JSON)
const dynamicMocks = {}; // path -> { status, headers, body }

app.post("/_admin/mock", express.json({ limit: '1mb' }), (req, res) => {
  const { path: p, status = 200, headers = { "Content-Type": "application/json" }, body = {} } = req.body || {};
  if (!p) return res.status(400).json({ error: "missing path" });
  dynamicMocks[p] = { status, headers, body };
  console.log(`[ADMIN MOCK] set ${p}`);
  res.json({ ok: true });
});

app.post("/_admin/mock/clear", express.json({ limit: '1mb' }), (req, res) => {
  const { path: p } = req.body || {};
  if (!p) return res.status(400).json({ error: "missing path" });
  delete dynamicMocks[p];
  console.log(`[ADMIN MOCK] cleared ${p}`);
  res.json({ ok: true });
});

// Admin endpoints to inspect recent requests
app.get("/_admin/recent", (req, res) => {
  res.json({ count: recentRequests.length, recent: recentRequests.slice(-50).reverse() });
});
app.get("/_admin/request/:id", (req, res) => {
  const id = req.params.id;
  const found = recentRequests.find(r => r.id === id);
  if (!found) return res.status(404).json({ error: "not found" });
  res.json(found);
});

// Intercept dynamic mocks before proxying
app.use((req, res, next) => {
  if (dynamicMocks[req.path]) {
    const m = dynamicMocks[req.path];
    Object.entries(m.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
    console.log(`[MOCK HIT] ${req.method} ${req.path}`);
    return res.status(m.status).send(typeof m.body === "string" ? m.body : JSON.stringify(m.body));
  }
  next();
});

// --- Helper: choose target based on incoming Host header or path heuristics ---
function pickTarget(req) {
  const host = (req.headers.host || "").toLowerCase();
  const pathStr = req.url || "";

  if (host.includes("pixelgun") || pathStr.includes("/get_files_info.php") || pathStr.includes("/advert_bcw")) {
    return TARGETS.pixelgun;
  }
  if (host.includes("fyber") || pathStr.includes("sdk-config") || pathStr.includes("video-cache")) {
    return TARGETS.fyber;
  }
  return TARGETS.bcw;
}

function isLikelyAndroid(req) {
  const ua = (req.headers['user-agent'] || "").toLowerCase();
  const orig = (req.originalUrl || "").toLowerCase();
  if (ua.includes("android") || orig.includes("platform=android") || orig.includes("_android.json")) return true;
  return false;
}

// --- Main proxy with request/response instrumentation ---
app.use("/", (req, res, next) => {
  const reqId = uuidv4();
  const startedAt = Date.now();
  const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
  const ua = req.headers["user-agent"] || "";

  // buffer request body (we used express.raw earlier)
  let reqBodyText = "";
  try {
    if (req.body && Buffer.isBuffer(req.body)) {
      reqBodyText = req.body.toString("utf8");
    } else if (req.body) {
      reqBodyText = JSON.stringify(req.body);
    }
  } catch (e) {
    reqBodyText = "<unreadable>";
  }

  console.log(`[GREQ] ${reqId} ${clientIp} ${req.method} ${req.originalUrl} UA:${ua}`);

  const target = pickTarget(req);

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    selfHandleResponse: true,
    onProxyReq(proxyReq, req, res) {
      try {
        // Tag proxied request for traceability
        proxyReq.setHeader("X-Request-Id", reqId);
        proxyReq.setHeader("X-Gateway-ClientIP", clientIp);
        proxyReq.setHeader("X-Gateway-Tag", "ybcw-gate");

        // Normalize UA and platform to iOS for backend acceptance
        proxyReq.setHeader("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");
        proxyReq.setHeader("X-Platform-Override", "iOS");

        // rewrite query string to canonical iOS-ish params and ensure signature fallback
        try {
          const parsed = url.parse(proxyReq.path || req.url, true);
          parsed.query.platform = 'ios';
          parsed.query.os_name = 'iPhone OS';
          parsed.query.client = 'ios';
          if (!parsed.query.phone_model) parsed.query.phone_model = 'iPad15,7';
          if (!parsed.query.manufacturer) parsed.query.manufacturer = 'Apple Inc.';
          parsed.query.signature = parsed.query.signature ? parsed.query.signature : 'ANDROID_BYPASS_SIGNATURE';
          proxyReq.path = url.format({ pathname: parsed.pathname, query: parsed.query });
        } catch (e) {
          console.warn(`[GATEWAY] query rewrite failed: ${e && e.message}`);
        }

        // If request body was buffered, rewrite "android" -> "ios" and write to proxied request
        if (reqBodyText && proxyReq.write) {
          let bodyStr = reqBodyText;
          if (bodyStr.toLowerCase().includes("android")) {
            bodyStr = bodyStr.replace(/android/gi, "ios");
          }
          proxyReq.setHeader("content-length", Buffer.byteLength(bodyStr, 'utf8'));
          proxyReq.write(Buffer.from(bodyStr, 'utf8'));
          proxyReq.end();
        }
      } catch (err) {
        console.warn("[GATEWAY] onProxyReq error:", err && err.message);
      }
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      try {
        const took = Date.now() - startedAt;
        const respStatus = proxyRes.statusCode;
        const respHeaders = proxyRes.headers || {};
        const bodySnippet = responseBuffer ? responseBuffer.toString("utf8") : "";

        console.log(`[GPROXY] ${reqId} -> ${target} ${req.method} ${req.originalUrl} [${respStatus}] ${took}ms`);
        pushRecent({
          id: reqId,
          ts: new Date().toISOString(),
          clientIp,
          ua,
          method: req.method,
          url: req.originalUrl,
          target,
          requestBody: VERBOSE ? reqBodyText : (reqBodyText ? "[present]" : ""),
          status: respStatus,
          responseHeaders: respHeaders,
          responseBodySnippet: VERBOSE ? bodySnippet.substring(0, 2000) : (bodySnippet ? bodySnippet.substring(0, 500) : ""),
          took
        });

        // If Android client and response contained ios filenames, rewrite them back to android
        if (isLikelyAndroid(req) && bodySnippet && typeof bodySnippet === "string") {
          let rewritten = bodySnippet
            .replace(/_ios\.json/g, "_android.json")
            .replace(/iphone os/gi, "Android")
            .replace(/ipad/gi, "Pixel 6");

          // Return rewritten body (if content is textual)
          if ((proxyRes.headers['content-type'] || "").includes("application/json") ||
              (proxyRes.headers['content-type'] || "").includes("text/")) {
            return Buffer.from(rewritten, "utf8");
          }
        }

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
  if (VERBOSE) console.log(`[VERBOSE] Logging enabled; writing to ${LOG_FILE}`);
});
