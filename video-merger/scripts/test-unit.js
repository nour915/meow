// اختبار وحدات المحرك: يولّد فيديوهين مختلفي الدقة بـ ffmpeg (أحدهما بصوت والآخر صامت)،
// يدمجهما عبر runMergeJob، ويتحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت،
// ثم يختبر التخزين في Turso والاسترجاع بتطابق sha256، وحدود الحجم، والحذف الشامل.
// تشغيل: node scripts/test-unit.js
process.env.FFMPEG_PRESET = process.env.FFMPEG_PRESET || "veryfast";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { runMergeJob, probe, ffmpegBin } = require("../lib/merge");
const dbx = require("../lib/db");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  OK  ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d.toString()));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(0, 300)))));
  });
}

async function makeClip(dest, w, h, seconds, withAudio) {
  const ff = ffmpegBin();
  const src = withAudio
    ? ["-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`]
    : ["-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`];
  const args = ["-hide_banner", "-y", ...src, "-c:v", "libx264", "-pix_fmt", "yuv420p"];
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(dest);
  await run(ff, args);
  const p = await probe(dest);
  return { dest, probe: p };
}

async function main() {
  console.log("== اختبار وحدات محرك الدمج ==");
  await dbx.ensureSchema();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mergetest-"));
  const jobId = "unit" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  // فيديوهان مختلفا الدقة: 640x360 بصوت + 320x240 صامت — الدقة المستهدفة = 640x360
  const a = await makeClip(path.join(tmp, "a.mp4"), 640, 360, 3, true);
  const b = await makeClip(path.join(tmp, "b.mp4"), 320, 240, 2, false);
  check("توليد المقاطع", a.probe.duration >= 2.9 && b.probe.duration >= 1.9);

  // تسجيل مصادر: رابط؟ لا — نستخدم ملفين مرفوعين لاختبار مسار الأجزاء أيضًا
  await dbx.insertJob(jobId, new Date(Date.now() + 3600e3).toISOString().replace("T", " ").slice(0, 19), "uploading");
  await dbx.insertSources(jobId, [
    { kind: "file", name: "a.mp4", mime: "video/mp4", size: fs.statSync(a.dest).size },
    { kind: "file", name: "b.mp4", mime: "video/mp4", size: fs.statSync(b.dest).size },
  ]);
  await dbx.writeBlob("source", jobId, 0, fs.readFileSync(a.dest));
  await dbx.writeBlob("source", jobId, 1, fs.readFileSync(b.dest));

  const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  const shaA = sha(fs.readFileSync(a.dest));

  // الاسترجاع من Turso بتطابق sha256 (رفع الأجزاء + القراءة التدفقية)
  const stream = dbx.readBlobStream("source", jobId, 0, null, null);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const recovered = Buffer.concat(chunks);
  check("الاسترجاع من Turso يطابق sha256", sha(recovered) === shaA);

  // دعم Range: قراءة المدى 10..49 (40 بايت) والتحقق من الطول والمحتوى
  const rs = dbx.readBlobStream("source", jobId, 0, 10, 49);
  const rc = [];
  for await (const c of rs) rc.push(c);
  const ranged = Buffer.concat(rc);
  check("قراءة Range 10-49 تعطي 40 بايت", ranged.length === 40 && ranged.equals(recovered.subarray(10, 50)));

  // تنفيذ الدمج
  const result = await runMergeJob(jobId, (p) => {});
  check("اكتمال الدمج", result && result.size > 0, `${result.size} bytes`);
  check("الدقة = أكبر دقة مدخل (640x360)", result.resolution === "640x360", result.resolution);
  check(
    "المدة ≈ مجموع المدد (5ث ±0.6)",
    Math.abs(result.duration - (a.probe.duration + b.probe.duration)) < 0.6,
    `${result.duration}s vs ${(a.probe.duration + b.probe.duration).toFixed(2)}s`
  );
  // وجود الصوت في الناتج
  const outTmp = path.join(tmp, "out.mp4");
  const outStream = dbx.readBlobStream("output", jobId, null, null, null);
  const oc = [];
  for await (const c of outStream) oc.push(c);
  fs.writeFileSync(outTmp, Buffer.concat(oc));
  const outProbe = await probe(outTmp);
  check("وجود الصوت في الناتج", outProbe.hasAudio === true);
  const storedSum = await dbx.db().execute({
    sql: "SELECT COALESCE(SUM(length(data)), 0) AS total FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  check("حجم الناتج المخزّن مطابق", Number(storedSum.rows[0].total) === result.size);

  // حذف source_chunks بعد نجاح الدمج
  const srcAfter = await dbx.sourceBytesTotal(jobId, 0);
  check("حذف source_chunks بعد الدمج", srcAfter.total === 0);

  // الحذف الشامل
  await dbx.deleteJobAll(jobId);
  const gone = await dbx.getJob(jobId);
  check("الحذف الشامل للمهمة", gone === null);
  let outRows = 0;
  const r = await dbx.db().execute({ sql: "SELECT COUNT(*) AS n FROM output_chunks WHERE job_id = ?", args: [jobId] });
  outRows = Number(r.rows[0].n);
  check("حذف صفوف output_chunks", outRows === 0);

  // حدود الحجم: مصدر أكبر من الحد المسموح (الحدود getters — يتتبع تغيّر process.env)
  const origMax = process.env.SOURCE_MAX_MB;
  process.env.SOURCE_MAX_MB = "0"; // 0MB → أي مصدر يتجاوز الحد
  try {
    await dbx.insertJob("unitlimit", new Date(Date.now() + 3600e3).toISOString().replace("T", " ").slice(0, 19), "queued");
    await dbx.insertSources("unitlimit", [{ kind: "file", name: "big.mp4", mime: "video/mp4", size: 100 }]);
    await dbx.writeBlob("source", "unitlimit", 0, Buffer.alloc(1024 * 1024, 7));
    const mergeMod = require("../lib/merge");
    let threw = false;
    try {
      await mergeMod.runMergeJob("unitlimit", () => {});
    } catch (e) {
      threw = /تجاوز الحد/.test(e.message) || /SOURCE_MAX_MB|0MB/.test(e.message);
      if (!threw) throw e;
    }
    check("رفض مصدر يتجاوز حد الحجم برسالة واضحة", threw);
    await dbx.deleteJobAll("unitlimit");
  } finally {
    process.env.SOURCE_MAX_MB = origMax;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل الاختبار:", e.message || e);
  process.exit(1);
});
