// محرك الدمج — جودة عالية إلزامية:
// توحيد كل المصادر عبر filter_complex (scale + pad إلى أكبر دقة بين المدخلات بحد 1920x1080 وأبعاد زوجية،
// fps=30، setsar=1، format=yuv420p) ثم concat. مصدر بلا صوت يُعوَّض بمسار صامت anullsrc بنفس مدته.
// الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — MP4 عالي الجودة يعمل فورًا على الويب.
// التقدم: يُقرأ out_time_us من -progress pipe:1 ويُحسب من المدة الإجمالية (0-40 سحب المصادر، 40-90 ترميز، 100 اكتمال).
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { limits } = require("./env");
const dbx = require("./db");

class MergeError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: ننسخه إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(src) {
  if (!src || !fs.existsSync(src)) return "ffmpeg"; // fallback للنظام إن لم يوجد الثنائي المضمّن
  const hash = crypto.createHash("md5").update(String(src)).digest("hex").slice(0, 8);
  const dest = path.join(os.tmpdir(), `bin-${path.basename(src)}-${hash}`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
  return dest;
}

function ffmpegBin() {
  return ensureExecutable(ffmpegStatic);
}

function ffprobeBin() {
  const p = ffprobeStatic && ffprobeStatic.path;
  return ensureExecutable(p);
}

function run(bin, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new MergeError(`فشل تشغيل الأداة: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
async function probe(file) {
  const bin = ffprobeBin();
  const r = await run(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (r.code !== 0) {
    throw new MergeError(`تعذر قراءة أحد المصادر (ليس ملف فيديو صالحًا أو الرابط يرفض الوصول): ${r.stderr.slice(0, 200)}`, 400);
  }
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    throw new MergeError("استجابة ffprobe غير مفهومة", 500);
  }
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new MergeError("أحد المصادر لا يحتوي مسار فيديو", 400);
  const duration = Number(
    (v.duration != null ? v.duration : null) || (info.format && info.format.duration) || 0
  );
  let fps = 0;
  if (v.avg_frame_rate && v.avg_frame_rate.includes("/")) {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (n > 0 && d > 0) fps = n / d;
  }
  return {
    width: Number(v.width),
    height: Number(v.height),
    fps,
    duration,
    hasAudio: Boolean(a),
  };
}

// تنزيل مصدر رابط إلى /tmp مع فحص الحجم أثناء التنزيل بمعدّل بايتات
async function downloadUrlSource(url, dest, maxBytes, onProgress) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new MergeError(`تعذر تنزيل المصدر ${url}: ${e.message}`, 400);
  }
  if (!res.ok) {
    throw new MergeError(`المصدر رفض التنزيل (HTTP ${res.status}): ${url}`, 400);
  }
  const cl = res.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw new MergeError(`حجم المصدر يتجاوز الحد (${limits.SOURCE_MAX_MB}MB لكل مصدر): ${url}`, 400);
  }
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      reader.cancel().catch(() => {});
      out.destroy();
      try {
        fs.unlinkSync(dest);
      } catch {}
      throw new MergeError(`حجم المصدر تجاوز الحد أثناء التنزيل (${limits.SOURCE_MAX_MB}MB): ${url}`, 400);
    }
    if (onProgress && bytes % (8 * 1024 * 1024) < value.length) onProgress(bytes);
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  out.end();
  await new Promise((r) => out.on("close", r));
  if (bytes === 0) throw new MergeError(`المصدر فارغ: ${url}`, 400);
  return bytes;
}

// تجميع ملف مرفوع من صفوف source_chunks إلى /tmp
async function assembleFileSource(jobId, seq, dest) {
  const { total } = await dbx.sourceBytesTotal(jobId, seq);
  if (total === 0) throw new MergeError(`مصدر مرفوع بدون أجزاء (المصدر رقم ${seq + 1}) — أكمل الرفع أولًا`, 409);
  if (total > limits.SOURCE_MAX_MB * 1024 * 1024) {
    throw new MergeError(`حجم المصدر المرفوع يتجاوز الحد (${limits.SOURCE_MAX_MB}MB)`, 400);
  }
  const out = fs.createWriteStream(dest);
  const stream = dbx.readBlobStream("source", jobId, seq, null, null);
  await new Promise((resolve, reject) => {
    stream.pipe(out);
    stream.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  return total;
}

// حساب هدف التوحيد: أكبر دقة بين المدخلات بحد أقصى 1920x1080 وأبعاد زوجية
function targetDimensions(probes) {
  let w = 0;
  let h = 0;
  for (const p of probes) {
    w = Math.max(w, p.width);
    h = Math.max(h, p.height);
  }
  const TW = Math.min(w || 1280, 1920);
  const TH = Math.min(h || 720, 1080);
  return {
    width: TW % 2 === 0 ? TW : TW - 1,
    height: TH % 2 === 0 ? TH : TH - 1,
  };
}

// تنفيذ الدمج الكامل لمهمة — يرجع { size, duration, resolution } ويكتب الناتج في output_chunks
async function runMergeJob(jobId, onProgress = () => {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  try {
    const sources = await dbx.listSources(jobId);
    if (!sources.length) throw new MergeError("لا توجد مصادر لهذه المهمة", 409);

    /* --- المرحلة 0-40: سحب المصادر --- */
    const local = [];
    const probes = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src-${i}.bin`);
      let bytes;
      if (s.kind === "url") {
        bytes = await downloadUrlSource(s.url, dest, limits.SOURCE_MAX_MB * 1024 * 1024);
      } else {
        bytes = await assembleFileSource(jobId, s.seq, dest);
      }
      const p = await probe(dest);
      probes.push(p);
      local.push(dest);
      onProgress(Math.round(((i + 1) / sources.length) * 40));
    }

    const totalDuration = probes.reduce((a, b) => a + (b.duration || 0), 0);
    if (totalDuration > limits.MAX_TOTAL_DURATION_SEC) {
      throw new MergeError(
        `مجموع مدد المقاطع (${Math.round(totalDuration)}ث) يتجاوز الحد (${limits.MAX_TOTAL_DURATION_SEC} ثانية)`,
        400
      );
    }
    const { width: TW, height: TH } = targetDimensions(probes);

    /* --- بناء inputs + filter_complex --- */
    const args = ["-hide_banner", "-y"];
    const silentInputIndex = {};
    let silentCount = 0;
    const inputArgs = [];
    local.forEach((f) => inputArgs.push("-i", f));
    sources.forEach((s, i) => {
      if (!probes[i].hasAudio) {
        // مصدر بلا صوت: أضف مسارًا صامتًا بنفس مدته بدل أن يفشل الدمج
        inputArgs.push("-f", "lavfi", "-t", String(probes[i].duration || 1), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
        silentInputIndex[i] = local.length + silentCount;
        silentCount++;
      }
    });
    args.push(...inputArgs);

    const n = sources.length;
    const chains = [];
    for (let i = 0; i < n; i++) {
      chains.push(
        `[${i}:v]scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
      );
      if (probes[i].hasAudio) {
        chains.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
      } else {
        chains.push(`[${silentInputIndex[i]}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
      }
    }
    const pairs = sources.map((_, i) => `[v${i}][a${i}]`).join("");
    chains.push(`${pairs}concat=n=${n}:v=1:a=1[vout][aout]`);

    const outPath = path.join(tmpDir, "output.mp4");
    args.push(
      "-filter_complex", chains.join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", limits.FFMPEG_PRESET,
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      outPath
    );

    /* --- المرحلة 40-90: الترميز مع قراءة التقدم --- */
    const bin = ffmpegBin();
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let buf = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 280_000);
      child.stdout.on("data", (c) => {
        buf += c.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m && totalDuration > 0) {
            const sec = Number(m[1]) / 1e6;
            const pct = 40 + Math.min(50, Math.max(0, (sec / totalDuration) * 50));
            onProgress(Math.round(pct));
          }
        }
      });
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new MergeError(`فشل تشغيل ffmpeg: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) resolve();
        else reject(new MergeError(`فشل الترميز: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300) || `exit ${code}`}`));
      });
    });

    /* --- فحص حجم الناتج ثم التخزين --- */
    const size = fs.statSync(outPath).size;
    if (size > limits.OUTPUT_MAX_MB * 1024 * 1024) {
      throw new MergeError(`حجم الناتج (${(size / 1048576).toFixed(1)}MB) يتجاوز الحد (${limits.OUTPUT_MAX_MB}MB)`, 400);
    }
    // مدة الناتج الفعلية من الناتج نفسه
    const outProbe = await probe(outPath);
    const resolution = `${TW}x${TH}`;
    onProgress(95);
    const data = fs.readFileSync(outPath);
    await dbx.writeBlob("output", jobId, null, data);
    // بعد نجاح الدمج احذف source_chunks — الناتج فقط هو المطلوب
    await dbx.db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
    onProgress(100);
    return { size, duration: Math.round(outProbe.duration * 10) / 10, resolution };
  } finally {
    // /tmp فقط أثناء المعالجة — نظّفه دائمًا
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = { runMergeJob, probe, MergeError, ffmpegBin, ffprobeBin, targetDimensions };
