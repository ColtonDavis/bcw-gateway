import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = process.env.PORT || 10000;

// Targets for proxy
const targets = {
  bcw: "https://bcwserver.com",
  pixelgun: "https://secure.pixelgunserver.com",
  fyber: "https://engine.fyber.com"
};
app.get("/_status", (req, res) => {
  res.send("OK");
});

// Middleware
app.use(morgan("dev"));

// Root check
app.get("/", (req, res) => {
  res.send(`🚀 Gateway running on port ${PORT}`);
});

// Proxy routes
app.use(
  "/blockcity",
  createProxyMiddleware({
    target: targets.bcw,
    changeOrigin: true,
    pathRewrite: { "^/blockcity": "" },
    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader("X-Request-ID", uuidv4());
    }
  })
);

app.use(
  "/get_files_info.php",
  createProxyMiddleware({
    target: targets.pixelgun,
    changeOrigin: true
  })
);

app.use(
  "/fyber",
  createProxyMiddleware({
    target: targets.fyber,
    changeOrigin: true,
    pathRewrite: { "^/fyber": "" }
  })
);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Gateway running on port ${PORT}`);
  console.log("Targets:", targets);
});
