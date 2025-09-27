// gateway.js -- reverse-proxy with rewrites + response logging
import express from "express";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 8080;

const TARGETS = {
  bcw: process.env.TARGET_BCW || "https://bcwserver.com",
  pixelgun: process.env.TARGET_PIXELGUN || "https://secure.pixelgunserver.com",
  fyber: process.env.TARGET_FYBER || "https://engine.fyber.com"
};

app.use(morgan("combined"));

// helper: pick target
function pickTarget(req) {
  const path = req.url || "";
  if (path.includes("pixelgun") || path.includes("/get_files_info.php") || path.includes("/advert_bcw"))
    return TARGETS.pixelgun;
  if (path.includes("fyber") || path.includes("sdk-config") || path.includes("video-cache"))
    return TARGETS.fyber;
  return TARGETS.bcw;
}

// --- HEALTH ---
app.get("/", (req, res) => res.send("✅ Gateway running. Use /_status for JSON healthcheck."));
app.get("/_status", (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- PROXY ---
app.use("/", (req, res, next) => {
  const target = pickTarget(req);
  console.log(`[GATEWAY] ${req.method} ${req.originalUrl} -> ${target}`);

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    preserveHeaderKeyCase: true,
    selfHandleResponse: true, // needed for logging body
    onProxyReq(proxyReq, req, res) {
      // Spoof platform as iOS
      proxyReq.setHeader("X-Platform-Override", "iOS");

      // Rewrite android → ios inside request body
      let bodyData = [];
      req.on("data", chunk => bodyData.push(chunk));
      req.on("end", () => {
        if (bodyData.length) {
          let body = Buffer.concat(bodyData).toString();
          if (body.includes("android")) {
            body = body.replace(/android/gi, "ios");
            proxyReq.setHeader("content-length", Buffer.byteLength(body));
            proxyReq.write(body);
          }
        }
      });
    },
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      const responseBody = responseBuffer.toString("utf8");

      console.log(`\n[PROXY RES] ${req.method} ${req.originalUrl}`);
      console.log("Status:", proxyRes.statusCode);
      console.log("Headers:", proxyRes.headers);
      console.log("Body:", responseBody.substring(0, 500)); // only log first 500 chars

      return responseBuffer; // return original response
    }),
    ws: true,
    logLevel: "warn"
  });

  return proxy(req, res, next);
});

app.listen(PORT, () => {
  console.log(`🚀 Gateway running on port ${PORT}`);
  console.log(`Targets: bcw=${TARGETS.bcw} pixelgun=${TARGETS.pixelgun} fyber=${TARGETS.fyber}`);
});
