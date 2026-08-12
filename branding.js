/**
 * Composites an uploaded logo onto the generated video using ffmpeg — not by asking
 * the AI video model to render it. Generative video models are unreliable at reproducing
 * exact logos/text (they tend to warp or approximate them), so for pixel-perfect branding
 * we composite the real logo file directly onto the output instead.
 *
 * Adds two things when a logo is provided:
 *   1. A semi-transparent watermark in the bottom-right corner for the whole video.
 *   2. A branded end-card (logo + tagline on a solid background) appended after the last scene.
 */

const path = require("path");
const { execFile } = require("child_process");

const DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const DEJAVU_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

function run(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed: ${stderr?.slice(-800) || err.message}`));
      resolve();
    });
  });
}

function dimsForAspect(aspectRatio) {
  return aspectRatio === "9:16" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
}

/**
 * Overlay the logo as a watermark in the bottom-right corner for the entire video duration.
 */
async function addWatermark(inputPath, logoPath, outputPath) {
  await run([
    "-y",
    "-i", inputPath,
    "-i", logoPath,
    "-filter_complex",
    "[1:v]scale=iw*0.35:-1,format=rgba,colorchannelmixer=aa=0.85[wm];[0:v][wm]overlay=W-w-24:H-h-24",
    "-c:a", "copy",
    outputPath,
  ]);
  return outputPath;
}

/**
 * Generate a short branded end-card: logo centered on a solid background, with an
 * optional tagline underneath. Includes a silent audio track so it concatenates
 * cleanly with the narrated scenes before it.
 */
async function makeEndCard({ logoPath, tagline, aspectRatio, durationSec = 3, bgColor = "0x0b0f1a" }, outputPath) {
  const { w, h } = dimsForAspect(aspectRatio);

  const filters = [`[2:v]scale=${Math.round(w * 0.28)}:-1[logo]`, `[0:v][logo]overlay=(W-w)/2:(H-h)/2-${Math.round(h * 0.06)}[bg]`];

  let finalLabel = "bg";
  if (tagline && tagline.trim()) {
    const escaped = tagline.replace(/:/g, "\\:").replace(/'/g, "\\'");
    filters.push(
      `[bg]drawtext=text='${escaped}':fontcolor=white:fontsize=${Math.round(w * 0.03)}:x=(w-text_w)/2:y=(h/2)+${Math.round(h * 0.12)}:fontfile=${DEJAVU_REGULAR}[withtext]`
    );
    finalLabel = "withtext";
  }

  await run([
    "-y",
    "-f", "lavfi", "-i", `color=c=${bgColor}:s=${w}x${h}:d=${durationSec}`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-i", logoPath,
    "-filter_complex", filters.join(";"),
    "-map", `[${finalLabel}]`,
    "-map", "1:a",
    "-shortest",
    "-c:v", "libx264",
    "-c:a", "aac",
    "-pix_fmt", "yuv420p",
    "-t", String(durationSec),
    outputPath,
  ]);
  return outputPath;
}

/**
 * Concatenate the (already stitched + watermarked) main video with the end-card.
 * Re-encodes rather than stream-copies since the two clips may not share identical
 * codec parameters.
 */
async function appendEndCard(mainPath, endCardPath, jobDir, outputPath) {
  const fs = require("fs");
  const listFile = path.join(jobDir, "final-concat-list.txt");
  fs.writeFileSync(listFile, `file '${mainPath}'\nfile '${endCardPath}'\n`);

  await run([
    "-y",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p",
    outputPath,
  ]);
  return outputPath;
}

/**
 * Full branding pass: watermark the stitched video, generate an end-card, and append it.
 * Returns the path to the final branded video.
 */
async function applyBranding({ stitchedPath, logoPath, tagline, aspectRatio, jobDir }) {
  const watermarkedPath = path.join(jobDir, "watermarked.mp4");
  await addWatermark(stitchedPath, logoPath, watermarkedPath);

  const endCardPath = path.join(jobDir, "endcard.mp4");
  await makeEndCard({ logoPath, tagline, aspectRatio }, endCardPath);

  const brandedPath = path.join(jobDir, "final.mp4");
  await appendEndCard(watermarkedPath, endCardPath, jobDir, brandedPath);

  return brandedPath;
}

module.exports = { applyBranding };
