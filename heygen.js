/**
 * HeyGen avatar video generation.
 *
 * Unlike Veo/Seedance/Kling/Grok Imagine, this is NOT a per-8-second-scene generative model —
 * it's the real thing: a specific chosen avatar, precisely lip-synced to your exact script text,
 * with no length cap. HeyGen composes all scenes into one continuous video itself, so this
 * bypasses the generate-per-scene + ffmpeg-stitch pipeline used for the other providers.
 *
 * Requires HEYGEN_API_KEY. Requires an avatar_id and voice_id from your HeyGen account
 * (fetch via listAvatars/listVoices below, or from the HeyGen dashboard).
 *
 * Docs: https://docs.heygen.com — verify endpoint paths/fields there before production use,
 * HeyGen's API surface evolves.
 */

const fs = require("fs");
const path = require("path");

const HEYGEN_API_BASE = "https://api.heygen.com";

function requireKey() {
  if (!process.env.HEYGEN_API_KEY) {
    throw new Error("HEYGEN_API_KEY is not set — required for the HeyGen avatar provider");
  }
}

async function heygenRequest(pathname, options = {}) {
  requireKey();
  const res = await fetch(`${HEYGEN_API_BASE}${pathname}`, {
    ...options,
    headers: {
      "X-Api-Key": process.env.HEYGEN_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HeyGen request failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/** List avatars available on the connected HeyGen account, for populating a picker UI. */
async function listAvatars() {
  const data = await heygenRequest("/v2/avatars", { method: "GET" });
  return (data.data?.avatars || []).map((a) => ({
    id: a.avatar_id,
    name: a.avatar_name,
    previewUrl: a.preview_image_url,
  }));
}

/** List voices available on the connected HeyGen account, for populating a picker UI. */
async function listVoices() {
  const data = await heygenRequest("/v2/voices", { method: "GET" });
  return (data.data?.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    language: v.language,
    previewUrl: v.preview_audio,
  }));
}

function dimsForAspect(aspectRatio) {
  return aspectRatio === "9:16" ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}

/**
 * Generate one continuous avatar video from the full script. Each script scene becomes one
 * "video input" in HeyGen's multi-scene payload — HeyGen renders and joins them itself.
 * Scenes with no dialogue are skipped (HeyGen scenes need spoken text).
 */
async function generateHeyGenVideo({ script, avatarId, voiceId, aspectRatio, jobDir }) {
  requireKey();
  if (!avatarId || !voiceId) {
    throw new Error("avatarId and voiceId are required for the HeyGen provider — pick them from your HeyGen avatar/voice list");
  }

  const scenesWithDialogue = script.scenes.filter((s) => s.dialogue_or_vo && s.dialogue_or_vo.trim());
  if (scenesWithDialogue.length === 0) {
    throw new Error("HeyGen needs at least one scene with dialogue text to generate an avatar video");
  }

  const video_inputs = scenesWithDialogue.map((scene) => ({
    character: {
      type: "avatar",
      avatar_id: avatarId,
      avatar_style: "normal",
    },
    voice: {
      type: "text",
      input_text: scene.dialogue_or_vo,
      voice_id: voiceId,
    },
    background: { type: "color", value: "#0b0f1a" },
  }));

  const { width, height } = dimsForAspect(aspectRatio);

  const submitted = await heygenRequest("/v2/video/generate", {
    method: "POST",
    body: JSON.stringify({
      video_inputs,
      dimension: { width, height },
    }),
  });

  const videoId = submitted.data?.video_id;
  if (!videoId) {
    throw new Error(`HeyGen did not return a video_id: ${JSON.stringify(submitted).slice(0, 300)}`);
  }

  // Poll for completion
  let status = "processing";
  let videoUrl = null;
  while (status === "processing" || status === "pending" || status === "waiting") {
    await new Promise((r) => setTimeout(r, 8000));
    const statusRes = await heygenRequest(`/v1/video_status.get?video_id=${videoId}`, { method: "GET" });
    status = statusRes.data?.status;
    if (status === "completed") {
      videoUrl = statusRes.data?.video_url;
    } else if (status === "failed") {
      throw new Error(`HeyGen video generation failed: ${JSON.stringify(statusRes.data?.error || statusRes).slice(0, 300)}`);
    }
  }

  if (!videoUrl) {
    throw new Error("HeyGen reported completion but returned no video_url");
  }

  const outPath = path.join(jobDir, "scenes.mp4");
  const videoRes = await fetch(videoUrl);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { generateHeyGenVideo, listAvatars, listVoices };
