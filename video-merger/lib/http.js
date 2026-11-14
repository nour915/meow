// أدوات HTTP مشتركة: CORS مفتوح، أخطاء بصيغة {"error":"..."}، قراءة الجسم (ثنائي أو JSON)
const { limits } = require("./env");

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(body);
}

function jsonError(res, status, message) {
  json(res, status, { error: message });
}

// قراءة الجسم الخام حتى حد أقصى — يعيد { buf, tooLarge }
function readRaw(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      total += c.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        req.resume(); // استهلاك الباقي ثم الإنهاء
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve({ buf: Buffer.concat(chunks), tooLarge }));
    req.on("error", () => resolve({ buf: Buffer.concat(chunks), tooLarge }));
  });
}

// قراءة JSON مع حد حجم — يرمي JsonError عند الجسم التالف
class JsonError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const { buf, tooLarge } = await readRaw(req, maxBytes);
  if (tooLarge) throw new JsonError("حجم الطلب كبير جدًا");
  if (!buf.length) throw new JsonError("الجسم فارغ — أرسل JSON صالحًا");
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new JsonError("JSON تالف — تحقق من صيغة الجسم");
  }
}

// الرابط الأساسي للردود — يوافق البروكسي (x-forwarded-*) أو المضيف المحلي
function baseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3011").split(",")[0].trim();
  return `${proto}://${host}`;
}

module.exports = { cors, json, jsonError, readRaw, readJson, JsonError, baseUrl, limits };
