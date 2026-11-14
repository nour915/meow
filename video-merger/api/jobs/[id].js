// GET /api/jobs/{id} — الحالة + التقدم (0-100) + الرابط عند الاكتمال
// DELETE /api/jobs/{id} — حذف فوري شامل (كل صفوف المهمة في batch واحد)
const { cors, json, jsonError, baseUrl } = require("../../lib/http");
const dbx = require("../../lib/db");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  const { id } = req.query || {};
  if (!id) return jsonError(res, 400, "معرّف المهمة مطلوب");
  try {
    await dbx.ensureSchema();
    const job = await dbx.getJob(id);
    if (req.method === "DELETE") {
      if (!job) return jsonError(res, 404, "المهمة غير موجودة");
      await dbx.deleteJobAll(id);
      return json(res, 200, { ok: true, deleted: id });
    }
    if (req.method !== "GET") return jsonError(res, 405, "طريقة غير مسموحة — استخدم GET أو DELETE");
    if (!job) return jsonError(res, 404, "المهمة غير موجودة");

    const base = baseUrl(req);
    const payload = {
      jobId: job.id,
      status: job.status,
      progress: Math.max(0, Math.min(100, Math.round(job.progress))),
      expiresAt: job.expires_at,
      createdAt: job.created_at,
    };
    if (job.status === "done") {
      payload.videoUrl = `${base}/api/jobs/${id}/video`;
      payload.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
      payload.size = job.output_size;
      payload.duration = job.output_duration;
      payload.resolution = job.output_resolution;
    }
    if (job.status === "failed") payload.error = job.error || "فشل غير معروف";
    return json(res, 200, payload);
  } catch (e) {
    console.error("jobs status error:", e.message);
    return jsonError(res, 500, "خطأ داخلي أثناء قراءة حالة المهمة");
  }
};
