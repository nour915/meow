// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
// حد حجم الطلب في Vercel ≈ 4.5MB → الرفع من الواجهة أجزاء POST ثنائية 4MB مع إعادة محاولة ×3.
const { cors, json, jsonError, readRaw, limits } = require("../lib/http");
const dbx = require("../lib/db");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return jsonError(res, 405, "طريقة غير مسموحة — استخدم POST");
  try {
    await dbx.ensureSchema();
    const q = req.query || {};
    const job = q.job;
    const seq = Number.parseInt(q.seq, 10);
    const chunk = q.chunk === undefined ? 0 : Number.parseInt(q.chunk, 10);
    if (!job || !Number.isInteger(seq) || seq < 0) {
      return jsonError(res, 400, "معطيات الرفع ناقصة — أرسل job وseq (وchunk اختياريًا)");
    }
    const jobRow = await dbx.getJob(job);
    if (!jobRow) return jsonError(res, 404, "المهمة غير موجودة");
    if (["processing", "done", "failed"].includes(jobRow.status)) {
      return jsonError(res, 409, `لا يمكن الرفع في حالة «${jobRow.status}»`);
    }
    const src = await dbx.getSource(job, seq);
    if (!src) return jsonError(res, 404, "المصدر غير موجود في هذه المهمة");
    if (src.kind !== "file") return jsonError(res, 400, "هذا المصدر رابط ولا يقبل رفع ملفات");

    const { buf, tooLarge } = await readRaw(req, limits.UPLOAD_CHUNK_BYTES + 1024);
    if (tooLarge) return jsonError(res, 413, `حجم الجزء يتجاوز الحد (${limits.UPLOAD_CHUNK_BYTES} بايت)`);
    if (!buf.length) return jsonError(res, 400, "الجسم فارغ — أرسل البايتات الخام (application/octet-stream)");

    await dbx.putChunk(job, seq, chunk, buf);
    if (jobRow.status === "queued") await dbx.updateJob(job, { status: "uploading" });
    return json(res, 200, { ok: true, job, seq, chunk, received: buf.length });
  } catch (e) {
    console.error("upload error:", e.message);
    return jsonError(res, 500, "خطأ داخلي أثناء رفع الجزء");
  }
};
