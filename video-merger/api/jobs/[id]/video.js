// GET /api/jobs/{id}/video — بث الناتج بدعم Range (استجابة 206 + Content-Range) ليعمل التقديم/الترجيع،
// و?download=1 للتحميل المباشر. تحويل صفوف الـ Blobs إلى stream مع تقليم أول/آخر جزء حسب المدى.
const { cors, jsonError } = require("../../../lib/http");
const dbx = require("../../../lib/db");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonError(res, 405, "طريقة غير مسموحة — استخدم GET");
  }
  const { id } = req.query || {};
  if (!id) return jsonError(res, 400, "معرّف المهمة مطلوب");
  try {
    await dbx.ensureSchema();
    const job = await dbx.getJob(id);
    if (!job) return jsonError(res, 404, "المهمة غير موجودة");
    if (job.status !== "done" || !job.output_size) {
      return jsonError(res, 409, `النتيجة غير جاهزة (الحالة الحالية: ${job.status})`);
    }

    const size = job.output_size;
    const isDownload = req.query.download === "1" || req.query.download === "true";
    const filename = `merged-${id}.mp4`;

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `${isDownload ? "attachment" : "inline"}; filename="${filename}"`);
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", size);
      res.statusCode = 200;
      res.end();
      return;
    }

    const range = String(req.headers.range || "");
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m) {
      let start = m[1] === "" ? null : parseInt(m[1], 10);
      let end = m[2] === "" ? null : parseInt(m[2], 10);
      if (start == null && end != null) {
        // صيغة suffix: آخر N بايت
        start = Math.max(0, size - end);
        end = size - 1;
      } else {
        if (start == null) start = 0;
        if (end == null || end >= size) end = size - 1;
      }
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.end();
      }
      const length = end - start + 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", length);
      const stream = dbx.readBlobStream("output", id, null, start, end);
      stream.on("error", () => res.end());
      stream.pipe(res);
      return;
    }

    // بدون Range: بث كامل 200
    res.statusCode = 200;
    res.setHeader("Content-Length", size);
    const stream = dbx.readBlobStream("output", id, null, null, null);
    stream.on("error", () => res.end());
    stream.pipe(res);
  } catch (e) {
    console.error("video stream error:", e.message);
    if (!res.headersSent) jsonError(res, 500, "خطأ داخلي أثناء بث الفيديو");
    else res.end();
  }
};
