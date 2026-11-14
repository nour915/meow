// GET /api/config — الحدود العامة + version (يُستخدم لفحص الجهوزية)
const { cors, json, limits } = require("../lib/http");

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "طريقة غير مسموحة — استخدم GET" });
  return json(res, 200, {
    version: "1.0.0",
    maxSources: limits.MAX_SOURCES,
    sourceMaxMB: limits.SOURCE_MAX_MB,
    outputMaxMB: limits.OUTPUT_MAX_MB,
    maxTotalDurationSec: limits.MAX_TOTAL_DURATION_SEC,
    uploadChunkBytes: limits.UPLOAD_CHUNK_BYTES,
    retentionHours: 24,
  });
};
