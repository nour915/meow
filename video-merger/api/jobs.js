// POST /api/jobs — إنشاء مهمة دمج (تنظيف كسول للمهام المنتهية عند كل إنشاء)
const crypto = require("crypto");
const { cors, json, jsonError, readJson, JsonError, baseUrl, limits } = require("../lib/http");
const dbx = require("../lib/db");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return jsonError(res, 405, "طريقة غير مسموحة — استخدم POST");
  try {
    await dbx.ensureSchema();
    dbx.purgeExpired().catch(() => {}); // تنظيف كسول لا يعطّل الإنشاء

    const body = await readJson(req);
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: "url", url: String(u || "") }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => {
        if (s && s.kind === "file") {
          return { kind: "file", name: String(s.name || "file"), mime: String(s.mime || "video/mp4"), size: Number(s.size || 0) };
        }
        return { kind: "url", url: s && s.url ? String(s.url) : "" };
      });
    } else {
      return jsonError(res, 400, 'الجسم يجب أن يكون {"videos":[...]} أو {"sources":[{"kind":"url|file",...}]}');
    }

    if (!sources.length) return jsonError(res, 400, "لا توجد مصادر — أرسل رابطًا أو ملفًا واحدًا على الأقل");
    if (sources.length > limits.MAX_SOURCES) {
      return jsonError(res, 400, `أقصى عدد مصادر هو ${limits.MAX_SOURCES}`);
    }
    for (const s of sources) {
      if (s.kind === "url" && !/^https?:\/\//i.test(s.url)) {
        return jsonError(res, 400, "كل الروابط يجب أن تكون http/https مباشرة وعامة");
      }
    }

    const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const hasFiles = sources.some((s) => s.kind === "file");
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    await dbx.insertJob(jobId, expiresAt, hasFiles ? "uploading" : "queued");
    await dbx.insertSources(jobId, sources);

    const base = baseUrl(req);
    const payload = {
      jobId,
      status: hasFiles ? "uploading" : "queued",
      statusUrl: `${base}/api/jobs/${jobId}`,
      processUrl: `${base}/api/jobs/${jobId}/process`,
      expiresAt,
    };
    if (hasFiles) {
      payload.uploadChunkBytes = limits.UPLOAD_CHUNK_BYTES;
      payload.uploads = sources
        .map((s, i) =>
          s.kind === "file"
            ? { seq: i, uploadUrl: `${base}/api/upload?job=${jobId}&seq=${i}`, uploadChunkBytes: limits.UPLOAD_CHUNK_BYTES, name: s.name, size: s.size }
            : null
        )
        .filter(Boolean);
    }
    return json(res, 201, payload);
  } catch (e) {
    if (e instanceof JsonError) return jsonError(res, e.statusCode, e.message);
    console.error("jobs create error:", e.message);
    return jsonError(res, 500, "خطأ داخلي أثناء إنشاء المهمة");
  }
};
