// اختبار HTTP كامل ضد خادم التطوير المحلي:
// إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 →
// JSON تالف → قائمة فارغة → الحدود (10 مصادر) → طريقة خاطئة (405).
// تشغيل: أطلق الخادم أولًا (npm run dev) ثم: node scripts/test-http.js
const BASE = process.env.TEST_BASE || "http://localhost:3011";

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  OK  ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

async function jfetch(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}

const CLIPS = [
  "https://www.w3schools.com/html/mov_bbb.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
];

async function main() {
  console.log("== اختبار HTTP كامل ضد " + BASE + " ==");

  // 0) config + cron
  const cfg = await jfetch("/api/config");
  check("GET /api/config يعمل", cfg.status === 200 && cfg.body.maxSources >= 1, `maxSources=${cfg.body.maxSources}`);
  const cron = await jfetch("/api/cron");
  check("GET /api/cron يعمل", cron.status === 200 && typeof cron.body.deleted === "number");

  // 1) مهمة من روابط → process → بث Range 206
  const created = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: CLIPS }),
  });
  check("إنشاء مهمة من روابط → 201", created.status === 201 && created.body.jobId, created.status + "");
  const jobId = created.body.jobId;
  check("statusUrl وprocessUrl صحيحان", /\/api\/jobs\/[\w-]+$/.test(created.body.statusUrl) && /\/process$/.test(created.body.processUrl));
  check("expiresAt موجود", Boolean(created.body.expiresAt));

  const proc = await jfetch(`/api/jobs/${jobId}/process`, { method: "POST" });
  check("الدمج يكتمل → done", proc.status === 200 && proc.body.status === "done", JSON.stringify(proc.body).slice(0, 120));
  check("videoUrl/downloadUrl على نطاق الخدمة", (proc.body.videoUrl || "").startsWith(BASE) && (proc.body.downloadUrl || "").includes("?download=1"));
  check("الحجم والمدة والدقة موجودة", proc.body.size > 0 && proc.body.duration > 0 && /x/.test(proc.body.resolution || ""), `${proc.body.resolution}`);

  // بث كامل ثم Range
  const v = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  const buf = Buffer.from(await v.arrayBuffer());
  check("بث كامل 200 بحجم مطابق", v.status === 200 && Number(v.headers.get("content-length")) === proc.body.size && buf.length === proc.body.size);
  const vr = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=100-199" } });
  const rb = Buffer.from(await vr.arrayBuffer());
  check(
    "Range → 206 + Content-Range + 100 بايت",
    vr.status === 206 && (vr.headers.get("content-range") || "") === `bytes 100-199/${proc.body.size}` && rb.length === 100
  );
  check("محتوى Range يطابق البث الكامل", rb.equals(buf.subarray(100, 200)));
  const suffix = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=-50" } });
  const sb = Buffer.from(await suffix.arrayBuffer());
  check("صيغة suffix bytes=-50", suffix.status === 206 && sb.length === 50 && sb.equals(buf.subarray(buf.length - 50)));
  check("Accept-Ranges: bytes", vr.headers.get("accept-ranges") === "bytes");
  const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
  check("?download=1 يعطي Content-Disposition attachment", (dl.headers.get("content-disposition") || "").includes("attachment"));

  // 2) مهمة مختلطة: رابط + ملف مرفوع (أجزاء 4MB عبر /api/upload)
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawn } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "httptest-"));
  const localClip = path.join(tmp, "c.mp4");
  await new Promise((resolve, reject) => {
    const c = spawn(require("../lib/merge").ffmpegBin(), [
      "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", localClip,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let e = "";
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(e.slice(0, 200)))));
    c.on("error", reject);
  });
  const clipBuf = fs.readFileSync(localClip);

  const mixed = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [
        { kind: "url", url: CLIPS[0] },
        { kind: "file", name: "c.mp4", size: clipBuf.length, mime: "video/mp4" },
      ],
    }),
  });
  check("إنشاء مهمة مختلطة → 201 مع uploads[]", mixed.status === 201 && Array.isArray(mixed.body.uploads) && mixed.body.uploads.length === 1);
  const mid = mixed.body.jobId;
  const up = mixed.body.uploads[0];
  const chunkBytes = up.uploadChunkBytes || 4194304;
  const nChunks = Math.ceil(clipBuf.length / chunkBytes);
  let uploadOk = true;
  for (let k = 0; k < nChunks; k++) {
    const part = clipBuf.subarray(k * chunkBytes, Math.min((k + 1) * chunkBytes, clipBuf.length));
    const r = await fetch(`${BASE}/api/upload?job=${mid}&seq=1&chunk=${k}`, { method: "POST", body: part, headers: { "Content-Type": "application/octet-stream" } });
    if (!r.ok) { uploadOk = false; break; }
  }
  check(`رفع الملف بأجزاء (${nChunks}) → نجاح`, uploadOk);
  const mproc = await jfetch(`/api/jobs/${mid}/process`, { method: "POST" });
  check("دمج المهمة المختلطة → done", mproc.status === 200 && mproc.body.status === "done", JSON.stringify(mproc.body).slice(0, 120));
  const mrange = await fetch(`${BASE}/api/jobs/${mid}/video`, { headers: { Range: "bytes=0-99" } });
  check("بث ناتج المهمة المختلطة يعمل", mrange.status === 206 || mrange.status === 200);

  // رفع جزء يتجاوز الحد → 413 (على مهمة جديدة في حالة uploading)
  const limJob = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: [{ kind: "file", name: "over.mp4", size: 10485760, mime: "video/mp4" }] }),
  });
  const limId = limJob.body.jobId;
  const over = await fetch(`${BASE}/api/upload?job=${limId}&seq=0&chunk=0`, {
    method: "POST",
    body: Buffer.alloc(4194304 + 2048),
    headers: { "Content-Type": "application/octet-stream" },
  });
  check("رفع جزء > 4MB → 413", over.status === 413, "HTTP " + over.status);
  await jfetch(`/api/jobs/${limId}`, { method: "DELETE" });

  // 3) حدود الحد الأقصى للمصادر (11 رابطًا)
  const eleven = Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`);
  const tooMany = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: eleven }) });
  check("11 مصدرًا → رفض 400", tooMany.status === 400, "HTTP " + tooMany.status);

  // رابط غير صالح → 400
  const badUrl = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: ["ftp://x.mp4", CLIPS[0]] }) });
  check("رابط غير http → 400", badUrl.status === 400);

  // 4) JSON تالف → 400
  const badJson = await jfetch("/api/jobs", { method: "POST", body: "{invalid" });
  check("JSON تالف → 400", badJson.status === 400, badJson.status + "");

  // 5) طريقة خاطئة → 405
  const wrongMethod = await jfetch("/api/jobs", { method: "GET" });
  check("GET على /api/jobs → 405", wrongMethod.status === 405);

  // 6) حذف ثم 404
  const del = await jfetch(`/api/jobs/${mid}`, { method: "DELETE" });
  check("حذف المهمة → ok", del.status === 200 && del.body.ok === true);
  const afterDel = await jfetch(`/api/jobs/${mid}`);
  check("بعد الحذف → 404", afterDel.status === 404);
  const delVid = await fetch(`${BASE}/api/jobs/${mid}/video`);
  check("بث بعد الحذف → 404", delVid.status === 404);
  const del404 = await jfetch("/api/jobs/notexist123", { method: "DELETE" });
  check("حذف مهمة غير موجودة → 404", del404.status === 404);

  // 7) عملية على مهمة قيد المعالجة → 202 (استخدم مهمة موجودة واجعلها processing يدويًا عبر قاعدة مباشرة)
  const dbx = require("../lib/db");
  await dbx.ensureSchema();
  await dbx.updateJob(jobId, { status: "processing", progress: 40 });
  const p202 = await jfetch(`/api/jobs/${jobId}/process`, { method: "POST" });
  check("process على مهمة جارية → 202", p202.status === 202, "HTTP " + p202.status);
  const st40 = await jfetch(`/api/jobs/${jobId}`);
  check("التقدم يظهر في الحالة", st40.body.progress === 40);
  // رجّعها done لتختبر delete النهائي أدناه
  await dbx.updateJob(jobId, { status: "done", progress: 100 });
  const finalDel = await jfetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  check("تنظيف مهمة الاختبار", finalDel.status === 200);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل الاختبار:", e);
  process.exit(1);
});
