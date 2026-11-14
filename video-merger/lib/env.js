// تحميل .env يدويًا (بدون مكتبة dotenv) — لا تُطبع أي أسرار في السجلات أبدًا
const fs = require("fs");
const path = require("path");

let loaded = false;
function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const p = path.join(__dirname, "..", ".env");
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    /* لا يوجد .env محليًا (Vercel يوفر متغيرات البيئة نفسه) */
  }
}

// الحدود العامة — كلها قابلة للضبط بمتغيرات البيئة (getters لتتبع تغيّر البيئة وقت التشغيل في الاختبارات)
loadEnv();
const limits = {
  get MAX_SOURCES() { return parseInt(process.env.MAX_SOURCES || "10", 10); },
  get SOURCE_MAX_MB() { return parseInt(process.env.SOURCE_MAX_MB || "200", 10); },
  get OUTPUT_MAX_MB() { return parseInt(process.env.OUTPUT_MAX_MB || "150", 10); },
  get MAX_TOTAL_DURATION_SEC() { return parseInt(process.env.MAX_TOTAL_DURATION_SEC || "600", 10); },
  get FFMPEG_PRESET() { return process.env.FFMPEG_PRESET || "medium"; },
  get UPLOAD_CHUNK_BYTES() { return 4 * 1024 * 1024; }, // رفع أجزاء 4MB — حد طلب Vercel ≈ 4.5MB
};

module.exports = { loadEnv, limits };
