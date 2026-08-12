/**
 * Edits an uploaded video according to a structured plan (trim, speed, aspect ratio,
 * captions, mute, fades). The plan is derived from the user's free-text request by an
 * LLM (see interpretEditPlan in providers.js / server.js) — this module only executes it.
 *
 * Each step writes an intermediate file and chains into the next, which is less efficient
 * than one mega ffmpeg command but far easier to reason about and debug when a step fails.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function run(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed: ${stderr?.slice(-800) || err.message}`));
      resolve();
    });
  });
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseFloat(stdout.trim()));
      }
    );
  });
}

function dimsForAspect(aspectRatio) {
  return aspectRatio === "9:16" ? { w: 720, h: 1280 } : aspectRatio === "1:1" ? { w: 1080, h: 1080 } : { w: 1280, h: 720 };
}

function toTimecode(seconds) {
  // ffmpeg accepts raw seconds fine for -ss/-to, keep it simple
  return String(seconds);
}

async function stepTrim(inputPath, trim, jobDir, stepNum) {
  const outPath = path.join(jobDir, `edit-${stepNum}-trim.mp4`);
  await run(["-y", "-ss", toTimecode(trim.start_seconds), "-to", toTimecode(trim.end_seconds), "-i", inputPath, "-c:v", "libx264", "-c:a", "aac", outPath]);
  return outPath;
}

async function stepSpeed(inputPath, multiplier, jobDir, stepNum) {
  const outPath = path.join(jobDir, `edit-${stepNum}-speed.mp4`);
  // atempo filter only accepts 0.5-2.0 per instance; chain multiple for larger ranges
  const atempoChain = [];
  let remaining = multiplier;
  if (remaining < 0.5 || remaining > 2.0) {
    // decompose into a chain of factors within [0.5, 2.0]
    while (remaining > 2.0) {
      atempoChain.push(2.0);
      remaining /= 2.0;
    }
    while (remaining < 0.5) {
      atempoChain.push(0.5);
      remaining /= 0.5;
    }
    atempoChain.push(remaining);
  } else {
    atempoChain.push(remaining);
  }
  const atempoFilter = atempoChain.map((f) => `atempo=${f.toFixed(4)}`).join(",");

  await run([
    "-y", "-i", inputPath,
    "-filter_complex", `[0:v]setpts=PTS/${multiplier}[v];[0:a]${atempoFilter}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-c:a", "aac",
    outPath,
  ]);
  return outPath;
}

async function stepAspectRatio(inputPath, aspectRatio, jobDir, stepNum) {
  const outPath = path.join(jobDir, `edit-${stepNum}-aspect.mp4`);
  const { w, h } = dimsForAspect(aspectRatio);
  await run([
    "-y", "-i", inputPath,
    "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "-c:a", "copy",
    outPath,
  ]);
  return outPath;
}

async function stepCaptions(inputPath, captions, jobDir, stepNum) {
  const outPath = path.join(jobDir, `edit-${stepNum}-captions.mp4`);
  const filters = captions.map((c) => {
    const escaped = String(c.text).replace(/:/g, "\\:").replace(/'/g, "\\'");
    return `drawtext=text='${escaped}':fontcolor=white:fontsize=42:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=h-140:fontfile=${DEJAVU_BOLD}:enable='between(t,${c.start_seconds},${c.end_seconds})'`;
  });
  await run(["-y", "-i", inputPath, "-vf", filters.join(","), "-c:a", "copy", outPath]);
  return outPath;
}

async function stepMute(inputPath, jobDir, stepNum) {
  const outPath = path.join(jobDir, `edit-${stepNum}-muted.mp4`);
  await run(["-y", "-i", inputPath, "-an", "-c:v", "copy", outPath]);
  return outPath;
}

async function stepFades(inputPath, { fadeIn, fadeOut, durationSec }, jobDir, stepNum) {
  const outPath = path.join(jobDir, `edit-${stepNum}-faded.mp4`);
  const parts = [];
  if (fadeIn) parts.push(`fade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut) parts.push(`fade=t=out:st=${Math.max(0, durationSec - fadeOut)}:d=${fadeOut}`);
  await run(["-y", "-i", inputPath, "-vf", parts.join(","), "-c:a", "copy", outPath]);
  return outPath;
}

/**
 * Apply a full edit plan to an uploaded video, step by step. Returns the path to the
 * edited video (before any logo/branding pass, which is applied separately by the caller
 * using the existing branding.js so behavior is identical across all video sources).
 */
async function applyEditPlan({ inputPath, plan, jobDir }) {
  let current = inputPath;
  let step = 0;

  if (plan.trim && plan.trim.start_seconds != null && plan.trim.end_seconds != null && plan.trim.end_seconds > plan.trim.start_seconds) {
    current = await stepTrim(current, plan.trim, jobDir, ++step);
  }

  if (plan.speed_multiplier && plan.speed_multiplier !== 1) {
    current = await stepSpeed(current, plan.speed_multiplier, jobDir, ++step);
  }

  if (plan.target_aspect_ratio) {
    current = await stepAspectRatio(current, plan.target_aspect_ratio, jobDir, ++step);
  }

  if (plan.captions && plan.captions.length > 0) {
    current = await stepCaptions(current, plan.captions, jobDir, ++step);
  }

  if (plan.mute_audio) {
    current = await stepMute(current, jobDir, ++step);
  }

  if (plan.fade_in_seconds || plan.fade_out_seconds) {
    const durationSec = await probeDuration(current);
    current = await stepFades(
      current,
      { fadeIn: plan.fade_in_seconds || 0, fadeOut: plan.fade_out_seconds || 0, durationSec },
      jobDir,
      ++step
    );
  }

  // Copy the last intermediate result to a stable, predictable filename
  const finalPath = path.join(jobDir, "edited.mp4");
  fs.copyFileSync(current, finalPath);
  return finalPath;
}

module.exports = { applyEditPlan, probeDuration };
