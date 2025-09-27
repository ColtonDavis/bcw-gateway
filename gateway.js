import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 as uuidv4 } from "uuid";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 10000;

// Add request ID middleware
app.use((req, res, next) => {
  req.id = uuidv4();
  next();
});

// Logging middleware
app.use(
  morgan(":date[iso] :id :method :url -> :status :res[content-length] bytes", {
    stream: process.stdout,
  })
);

// Add token to morgan logs
morgan.token("id", (req) => req.id);

// Target servers
const targets = {
  bcw: "https://bcwserver.com",
  pixelgun: "https://secure.pixelgunserver.com",
  fyber: "https://engine.fyber.com",
};

// Debug log
console.log("🚀 Gateway starting...");
console.log("Targets:", targets);

// Proxy helper
const makeProxy = (target) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
      console.log(`[GATEWAY][${req.id}] Forwarding -> ${target}${req.url}`);
    },
    onProxyRes: (proxyRes, req) => {
      console.log(
        `[GATEWAY][${req.id}] Response <- ${proxyRes.statusCode} from ${target}${req.url}`
      );
    },
  });

// Routes
app.use("/blockcity", makeProxy(targets.bcw));
app.use("/get_files_info.php", makeProxy(targets.pixelgun));
app.use("/ads", makeProxy(targets.fyber));

// Health check
app.get("/", (req, res) => {
  res.send("✅ Gateway is running");
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Listening on http://localhost:${PORT}`);
});
