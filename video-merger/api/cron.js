// GET /api/cron — حذف المهام المنتهية (Cron يومي عبر vercel.json: "0 3 * * *")
const { cors, json, jsonError } = require("../lib/http");
const dbx = require("../lib/db");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return jsonError(res, 405, "طريقة غير مسموحة — استخدم GET");
  try {
    await dbx.ensureSchema();
    const deleted = await dbx.purgeExpired();
    return json(res, 200, { ok: true, deleted, ranAt: new Date().toISOString() });
  } catch (e) {
    console.error("cron error:", e.message);
    return jsonError(res, 500, "خطأ داخلي أثناء التنظيف");
  }
};
