// خادم تطوير محلي يحاكي بيئة Vercel Serverless:
// يحلّل المسارات الديناميكية ويضعها في req.query (مثل منصة Vercel)، ويخدم public/index.html على الجذر.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../lib/env");

loadEnv();

const ROUTES = [
  { m: "GET", re: /^\/api\/config\/?$/, mod: "../api/config.js" },
  { m: "GET", re: /^\/api\/cron\/?$/, mod: "../api/cron.js" },
  { m: "POST", re: /^\/api\/upload\/?$/, mod: "../api/upload.js" },
  { m: "POST", re: /^\/api\/jobs\/?$/, mod: "../api/jobs.js" },
  { m: ["GET", "DELETE"], re: /^\/api\/jobs\/([^/]+)\/?$/, mod: "../api/jobs/[id].js", params: ["id"] },
  { m: "POST", re: /^\/api\/jobs\/([^/]+)\/process\/?$/, mod: "../api/jobs/[id]/process.js", params: ["id"] },
  { m: ["GET", "HEAD"], re: /^\/api\/jobs\/([^/]+)\/video\/?$/, mod: "../api/jobs/[id]/video.js", params: ["id"] },
];

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    for (const r of ROUTES) {
      const m = u.pathname.match(r.re);
      // مثل Vercel: توجيه كل الطرق إلى نفس المعالج — والمعالج يرفض الطريقة الخاطئة بـ 405
      if (m) {
        req.query = Object.fromEntries(u.searchParams);
        if (r.params) r.params.forEach((p, i) => { req.query[p] = decodeURIComponent(m[i + 1]); });
        // eslint-disable-next-line import/no-dynamic-require
        const handler = require(path.join(__dirname, r.mod));
        await handler(req, res);
        return;
      }
    }
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      fs.createReadStream(path.join(__dirname, "..", "public", "index.html")).pipe(res);
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "المسار غير موجود" }));
  } catch (e) {
    console.error("dev-server error:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.end();
    }
  }
});

const PORT = Number(process.env.DEV_PORT || 3011);
server.listen(PORT, () => console.log(`video-merger dev server: http://localhost:${PORT}`));
