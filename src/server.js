import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || ""; // optional bearer protection
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => (stdout += d.toString()));
    p.stderr?.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 800)}`));
    });
  });
}

function fmtTimestamp(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function modeToFps(mode) {
  switch (mode) {
    case "hook": return { fps: 4, duration: 10 };  // dense first 10s
    case "short": return { fps: 1, duration: 60 };
    case "deep": return { fps: 1, duration: 0 };
    case "ad":
    default: return { fps: 1, duration: 30 };
  }
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "clipscribe-worker", endpoints: ["POST /process", "GET /health"] });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/process", async (req, res) => {
  if (SHARED_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${SHARED_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const { url, platform = "auto", mode = "ad", frameWidth = 512 } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url" });

  const work = await mkdtemp(path.join(tmpdir(), "clip-"));
  const id = crypto.randomBytes(4).toString("hex");
  const videoPath = path.join(work, `${id}.mp4`);
  const audioPath = path.join(work, `${id}.mp3`);
  const framesDir = path.join(work, "frames");
  await writeFile(path.join(work, ".keep"), "");

  try {
    // 1) Download with yt-dlp (mp4-friendly format, capped resolution for speed)
    const ytArgs = [
      "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "-o", videoPath,
      url,
    ];
    await run("yt-dlp", ytArgs);

    // 2) ffprobe duration + resolution
    const probe = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      videoPath,
    ]);
    const probeJson = JSON.parse(probe.stdout);
    const stream = probeJson.streams?.[0] || {};
    const durationSeconds = Math.round(parseFloat(probeJson.format?.duration || "0"));
    const width = stream.width || 0;
    const height = stream.height || 0;
    const resolution = width && height ? `${width}x${height}` : "";

    // 3) Extract frames
    await run("mkdir", ["-p", framesDir]);
    const { fps, duration } = modeToFps(mode);
    const ffArgs = ["-y", "-i", videoPath];
    if (duration > 0) ffArgs.push("-t", String(duration));
    ffArgs.push(
      "-vf", `fps=${fps},scale=${frameWidth}:-2`,
      "-q:v", "4",
      path.join(framesDir, "f_%04d.jpg"),
    );
    await run("ffmpeg", ffArgs);

    const files = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
    const frames = [];
    for (let i = 0; i < files.length; i++) {
      const buf = await readFile(path.join(framesDir, files[i]));
      const tSec = i / fps;
      frames.push({
        name: files[i],
        timestamp: fmtTimestamp(tSec),
        t: tSec,
        dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
      });
    }

    // 4) Extract audio + transcribe via Groq Whisper (optional)
    let transcript = "";
    if (GROQ_API_KEY) {
      try {
        await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath]);
        const audioBuf = await readFile(audioPath);
        const fd = new FormData();
        fd.append("file", new Blob([audioBuf], { type: "audio/mpeg" }), "audio.mp3");
        fd.append("model", "whisper-large-v3-turbo");
        fd.append("response_format", "verbose_json");
        const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
          body: fd,
        });
        if (r.ok) {
          const j = await r.json();
          const segs = j.segments || [];
          transcript = segs.length
            ? segs.map((s) => `[${(s.start ?? 0).toFixed(1)}s] ${(s.text || "").trim()}`).join("\n")
            : (j.text || "");
        } else {
          transcript = "";
        }
      } catch (e) {
        transcript = "";
      }
    }

    // 5) videoReport ‚Äî lightweight summary (full AI report happens in the Lovable app)
    const videoReport = [
      `# Source\n- URL: ${url}\n- Platform: ${platform}\n- Mode: ${mode}`,
      `# Media\n- Duration: ${durationSeconds}s\n- Resolution: ${resolution}\n- Frames extracted: ${frames.length} @ ${fps}fps`,
      transcript ? `# Transcript preview\n${transcript.slice(0, 600)}${transcript.length > 600 ? "‚Ä¶" : ""}` : `# Transcript\n(none ‚Äî set GROQ_API_KEY to enable)`,
    ].join("\n\n");

    res.json({
      frames,
      transcript,
      duration: String(durationSeconds),
      durationSeconds,
      resolution,
      videoReport,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Worker error" });
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`clipscribe-worker listening on :${PORT}`));

