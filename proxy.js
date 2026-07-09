const { createProxyMiddleware } = require("http-proxy-middleware");
const express = require("express");
const app = express();

app.use(
  "/api",
  createProxyMiddleware({
    target:
      "https://f6d58b50-331b-4d49-8d4e-5b557ce90d77-us-east-2.apps.astra.datastax.com",
    changeOrigin: true,
    pathRewrite: {
      "^/api": "", // remove /api prefix when forwarding to the target
    },
    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader("Content-Type", "application/json");
    },
  })
);

app.listen(3001, () => {
  console.log("Proxy server is running on http://localhost:3001");
});
