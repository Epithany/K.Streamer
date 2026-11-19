const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { FFMPEG_PATH, FFPROBE_PATH } = require("./config");
const log = require("./logger").for("media");

// Every upload is made browser-safe (MP4/H.264/AAC, or MP3), but only as much
// as it needs: probe first, then copy whatever already plays and re-encode
// only what doesn't. A typical MKV (H.264 + AAC/AC-3) becomes a remux or an
// audio-only conversion that takes seconds, not a full video encode.
//
//   copy   container already fine           -> stream copy, +faststart
//   remux  H.264 8-bit + AAC stereo in MKV  -> stream copy into MP4
//   audio  H.264 8-bit, other audio         -> copy video, audio -> AAC
//   video  anything else (HEVC, 10-bit...)  -> x264 (or QSV if it works)
//
// Env: ENCODER=auto|x264|qsv (default auto), X264_PRESET (default veryfast),
//      X264_CRF (default 22), ENCODE_PRIORITY=low|normal (default low).

const PRESET = process.env.X264_PRESET || "veryfast";
const CRF = String(process.env.X264_CRF || 22);
const LOW_PRIORITY = process.env.ENCODE_PRIORITY !== "normal";

function run(cmd, args, { onStdoutLine, priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    if (priority && LOW_PRIORITY && child.pid) {
      // The host is also used for playback and games: encoding yields to them.
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    }
    let stdout = "";
    let stderr = "";
    let carry = "";
    child.stdout.on("data", (chunk) => {
      if (onStdoutLine) {
        carry += chunk;
        const lines = carry.split(/\r?\n/);
        carry = lines.pop();
        lines.forEach(onStdoutLine);
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function probe(file) {
  const out = await run(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries",
    "format=format_name,duration:stream=index,codec_type,codec_name,profile,pix_fmt,channels,disposition",
    "-of", "json",
    file,
  ]);
  const data = JSON.parse(out);
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic) || null;
  const audio = streams.find((s) => s.codec_type === "audio") || null;
  const duration = Number.parseFloat(data.format?.duration);
  return {
    format: String(data.format?.format_name || ""),
    duration: Number.isFinite(duration) ? duration : null,
    video: video && { codec: video.codec_name, pixFmt: video.pix_fmt, profile: video.profile || "" },
    audio: audio && { codec: audio.codec_name, channels: Number(audio.channels || 0) },
  };
}

// ---------- Hardware encoder (checked once, with a real test encode) ----------
let encoderPromise = null;
function pickEncoder() {
  if (encoderPromise) return encoderPromise;
  encoderPromise = (async () => {
    const wanted = (process.env.ENCODER || "auto").toLowerCase();
    if (wanted === "x264") return "libx264";
    try {
      const list = await run(FFMPEG_PATH, ["-hide_banner", "-encoders"]);
      if (!/h264_qsv/.test(list)) return "libx264";
      await run(FFMPEG_PATH, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2",
        "-pix_fmt", "nv12", "-c:v", "h264_qsv", "-f", "null", "-",
      ]);
      log.info("using Intel Quick Sync (h264_qsv) for video encodes");
      return "h264_qsv";
    } catch {
      return "libx264";
    }
  })();
  return encoderPromise;
}

const SAFE_PROFILES = new Set(["", "Baseline", "Constrained Baseline", "Main", "High"]);
const isH264Safe = (v) =>
  Boolean(v) && v.codec === "h264" && v.pixFmt === "yuv420p" && SAFE_PROFILES.has(v.profile);
const isAacSafe = (a) => !a || (a.codec === "aac" && a.channels <= 2);

function plan(info, type) {
  if (type === "song") {
    return info.audio?.codec === "mp3" && info.format.split(",").includes("mp3") ? "copy" : "audio";
  }
  if (!info.video) throw new Error("No video stream found in this file");
  const videoOk = isH264Safe(info.video);
  const audioOk = isAacSafe(info.audio);
  if (videoOk && audioOk) return info.format.split(",").includes("mp4") ? "copy" : "remux";
  return videoOk ? "audio" : "video";
}

// transcode(input, output, "video" | "short" | "song", { trimEnd, onProgress })
// trimEnd: seconds to cut off the tail (done in the same pass, no extra file).
async function transcode(input, output, type, { trimEnd = 0, onProgress } = {}) {
  const info = await probe(input);
  let mode = plan(info, type);
  let keep = null;
  if (trimEnd && info.duration && info.duration - trimEnd >= 1) keep = info.duration - trimEnd;

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-i", input];
  if (keep) args.push("-t", keep.toFixed(3));

  if (type === "song") {
    args.push("-map", "0:a:0?", "-vn");
    if (mode === "copy") args.push("-c:a", "copy");
    else args.push("-c:a", "libmp3lame", "-q:a", "2");
    args.push("-map_metadata", "0", "-f", "mp3", output);
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0", "-map_chapters", "0", "-sn", "-dn");
    if (mode === "copy" || mode === "remux" || mode === "audio") {
      args.push("-c:v", "copy");
    } else {
      const encoder = await pickEncoder();
      if (encoder === "h264_qsv") {
        args.push("-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "24");
      } else {
        args.push("-c:v", "libx264", "-preset", PRESET, "-crf", CRF, "-threads", "0");
      }
      args.push("-pix_fmt", encoder === "h264_qsv" ? "nv12" : "yuv420p");
      args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    }
    if (info.audio) {
      if (isAacSafe(info.audio)) args.push("-c:a", "copy");
      else args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
    }
    // Moov atom at the front: playback and seeking start without extra range requests.
    args.push("-movflags", "+faststart", "-f", "mp4", output);
  }

  const total = keep || info.duration || 0;
  await run(FFMPEG_PATH, args, {
    priority: true,
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && total && onProgress) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / total));
    },
  });
  onProgress?.(1);
  return { mode, trimmed: Boolean(keep), keptSeconds: keep, info };
}

// Does an MP4 have its moov atom before the media data? (Fast start.)
async function hasFaststart(file) {
  const fs = require("fs/promises");
  const fh = await fs.open(file, "r");
  try {
    let pos = 0;
    const head = Buffer.alloc(16);
    for (let i = 0; i < 64; i++) {
      const { bytesRead } = await fh.read(head, 0, 16, pos);
      if (bytesRead < 8) return false;
      let size = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      if (size < 8) return false;
      pos += size;
    }
    return false;
  } finally {
    await fh.close();
  }
}

module.exports = { transcode, probe, plan, hasFaststart };
