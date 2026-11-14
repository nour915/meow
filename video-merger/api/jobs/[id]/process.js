// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن): سحب المصادر ← ترميز ← حفظ → رابط الناتج
// جارية بالفعل → 202. أي خطأ مرمي من المحرك = فشل واضح برسالة عربية وليس انهيارًا.
const { cors, json, jsonError, baseUrl } = require("../../../lib/http");
const dbx = require("../../../lib/db");
const { runMergeJob, MergeError } = require("../../../lib/merge");

function donePayload(job, base) {
  return {
    status: "done",
    videoUrl: `${base}/api/jobs/${job.id}/video`,
    downloadUrl: `${base}/api/jobs/${job.id}/video?download=1`,
    size: job.output_size,
    duration: job.output_duration,
    resolution: job.output_resolution,
    expiresAt: job.expires_at,
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return jsonError(res, 405, "طريقة غير مسموحة — استخدم POST");
  const { id } = req.query || {};
  if (!id) return jsonError(res, 400, "معرّف المهمة مطلوب");
  try {
    await dbx.ensureSchema();
    const job = await dbx.getJob(id);
    if (!job) return jsonError(res, 404, "المهمة غير موجودة");
    if (job.status === "processing") {
      return json(res, 202, { status: "processing", progress: job.progress });
    }
    if (job.status === "done") {
      return json(res, 200, donePayload(job, baseUrl(req)));
    }
    if (job.status === "failed") {
      return jsonError(res, 500, job.error || "فشلت المهمة مسبقًا");
    }

    // queued/uploading → تحقق من اكتمال الملفات المرفوعة قبل الدمج
    const sources = await dbx.listSources(id);
    if (!sources.length) return jsonError(res, 409, "لا توجد مصادر لهذه المهمة");
    for (const s of sources) {
      if (s.kind === "file") {
        const { total } = await dbx.sourceBytesTotal(id, s.seq);
        if (total === 0) {
          return jsonError(res, 409, `الرفع غير مكتمل للمصدر رقم ${s.seq + 1} — ارفع أجزاء الملف أولًا`);
        }
        if (s.size > 0 && total < s.size * 0.999) {
          return jsonError(res, 409, `الرفع غير مكتمل للمصدر رقم ${s.seq + 1} (${total} من ${s.size} بايت)`);
        }
      }
    }

    await dbx.updateJob(id, { status: "processing", progress: 0 });
    try {
      const result = await runMergeJob(id, async (pct) => {
        // تحديث التقدم في القاعدة فورًا مع كل مرحلة (يقرؤه الاستطلاع من الواجهة)
        await dbx.updateJob(id, { progress: Math.max(0, Math.min(100, pct)) }).catch(() => {});
      });
      const updated = await dbx.updateJob(id, {
        status: "done",
        progress: 100,
        output_size: result.size,
        output_duration: result.duration,
        output_resolution: result.resolution,
      });
      return json(res, 200, donePayload(updated, baseUrl(req)));
    } catch (e) {
      const msg = e instanceof MergeError ? e.message : `فشل الدمج: ${e.message || e}`;
      await dbx.updateJob(id, { status: "failed", error: msg, progress: 100 }).catch(() => {});
      return jsonError(res, e instanceof MergeError ? e.statusCode || 500 : 500, msg);
    }
  } catch (e) {
    console.error("process error:", e.message);
    return jsonError(res, 500, "خطأ داخلي أثناء تنفيذ الدمج");
  }
};
