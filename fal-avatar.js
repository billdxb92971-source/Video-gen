/**
 * Real avatar lip-sync using fal.ai only (no HeyGen account needed).
 *
 * Mechanically this is much closer to what HeyGen actually does than the generative
 * scene models (Veo/Seedance/Kling/Grok Imagine): you supply a specific face (photo or
 * short video), text-to-speech generates audio from your script, and a dedicated lip-sync
 * model syncs that face's mouth to the generated audio. Same consistent face every time,
 * word-accurate because the audio *is* the script.
 *
 * Requires FAL_KEY only.
 *
 * IMPORTANT: model slugs/schemas are a best-effort snapshot — verify at https://fal.ai/models
 * before production use, especially FAL_LIPSYNC_MODEL and FAL_TTS_MODEL.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const FAL_API_BASE = "https://queue.fal.run";
const FAL_TTS_MODEL = process.env.FAL_TTS_MODEL || "fal-ai/kokoro";
const FAL_LIPSYNC_MODEL = process.env.FAL_LIPSYNC_MODEL || "fal-ai/sync-lipsync/v3";

function requireKey() {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is not set — required for the fal.ai Avatar provider");
  }
}

async function falRequest(pathname, options = {}) {
  requireKey();
  const res = await fetch(`${FAL_API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal.ai request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function falPoll(submitted) {
  const statusUrl = submitted.status_url;
  const responseUrl = submitted.response_url;
  if (!statusUrl || !responseUrl) {
    throw new Error(`Unexpected fal.ai submit response: ${JSON.stringify(submitted).slice(0, 300)}`);
  }
  let status = submitted.status;
  while (status !== "COMPLETED") {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(statusUrl, { headers: { Authorization: `Key ${process.env.FAL_KEY}` } });
    const statusJson = await statusRes.json();
    status = statusJson.status;
    if (status === "FAILED" || status === "ERROR") {
      throw new Error(`fal.ai job failed: ${JSON.stringify(statusJson).slice(0, 300)}`);
    }
  }
  const resultRes = await fetch(responseUrl, { headers: { Authorization: `Key ${process.env.FAL_KEY}` } });
  return resultRes.json();
}

/**
 * Combine a script's scene dialogue into one continuous narration. Scenes with no
 * dialogue are skipped — there's nothing for the lip-sync model to sync to.
 */
function buildNarration(script) {
  return script.scenes
    .map((s) => s.dialogue_or_vo)
    .filter((line) => line && line.trim())
    .join(". ");
}

/** Generate speech audio from text via a fal.ai TTS model. Returns a hosted audio URL. */
async function generateSpeech(text) {
  const submitted = await falRequest(`/${FAL_TTS_MODEL}`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  const result = await falPoll(submitted);
  const audioUrl = result.audio?.url || result.audio_url || result.output?.audio?.url;
  if (!audioUrl) {
    throw new Error(`Could not find audio URL in fal.ai TTS response: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return audioUrl;
}

/**
 * Sync a face video (passed as a base64 data URI so no separate storage upload step is
 * needed) to the given audio URL. Returns the resulting video's hosted URL.
 */
async function runLipSync(avatarDataUri, audioUrl) {
  const submitted = await falRequest(`/${FAL_LIPSYNC_MODEL}`, {
    method: "POST",
    body: JSON.stringify({
      video_url: avatarDataUri,
      audio_url: audioUrl,
    }),
  });
  const result = await falPoll(submitted);
  const videoUrl = result.video?.url || result.video_url || result.output?.video?.url;
  if (!videoUrl) {
    throw new Error(`Could not find video URL in fal.ai lip-sync response: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return videoUrl;
}

/**
 * fal-ai/sync-lipsync/v3 only accepts video input (mp4, mov, webm, m4v, gif) — not static
 * photos. If the uploaded avatar is a photo, convert it into a short silent looping video
 * first so the model has something valid to work with.
 */
function convertImageToVideo(imagePath, jobDir, durationSec = 4) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(jobDir, "avatar-from-photo.mp4");
    execFile(
      "ffmpeg",
      [
        "-y", "-loop", "1", "-i", imagePath,
        "-t", String(durationSec),
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "25",
        outPath,
      ],
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Converting avatar photo to video failed: ${stderr?.slice(-500) || err.message}`));
        resolve(outPath);
      }
    );
  });
}

/**
 * Full pipeline: script -> narration text -> TTS audio -> lip-synced video, using the
 * uploaded avatar face. Returns the path to the downloaded final video.
 */
async function generateFalAvatarVideo({ script, avatarBuffer, avatarMimeType, jobDir }) {
  requireKey();
  if (!avatarBuffer) {
    throw new Error("An avatar photo or short video is required for the fal.ai Avatar provider");
  }

  const narration = buildNarration(script);
  if (!narration) {
    throw new Error("The script has no spoken dialogue for the avatar to say — nothing to lip-sync to");
  }

  const audioUrl = await generateSpeech(narration);

  let videoBuffer = avatarBuffer;
  let videoMimeType = avatarMimeType;
  if (avatarMimeType.startsWith("image/")) {
    // sync-lipsync/v3 needs a video input — turn the photo into a short silent clip first
    const tempImagePath = path.join(jobDir, `avatar-source${avatarMimeType === "image/png" ? ".png" : ".jpg"}`);
    fs.writeFileSync(tempImagePath, avatarBuffer);
    const convertedPath = await convertImageToVideo(tempImagePath, jobDir);
    videoBuffer = fs.readFileSync(convertedPath);
    videoMimeType = "video/mp4";
  }

  const avatarDataUri = `data:${videoMimeType};base64,${videoBuffer.toString("base64")}`;
  const videoUrl = await runLipSync(avatarDataUri, audioUrl);

  const outPath = path.join(jobDir, "scenes.mp4");
  const videoRes = await fetch(videoUrl);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { generateFalAvatarVideo };
