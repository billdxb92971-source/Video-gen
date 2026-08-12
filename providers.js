/**
 * Video generation provider adapters + script-writing adapters.
 *
 * Each video provider exposes: generate(scene, opts, jobDir) -> Promise<filePath>
 * Each script provider exposes: writeScript({ prompt, sceneCount, aspectRatio, tone }) -> Promise<scriptObject>
 *
 * - "veo": calls Gemini API directly (Google GenAI SDK). Needs GEMINI_API_KEY.
 * - "seedance" / "kling" / "grok-imagine": video, routed through fal.ai's queue API. Needs FAL_KEY.
 * - "fal-llm": script writing via fal.ai's OpenRouter-backed LLM endpoint. Needs FAL_KEY.
 *
 * With just FAL_KEY set (no GEMINI_API_KEY), the app runs entirely on one provider:
 * script via "fal-llm" + video via "seedance"/"kling"/"grok-imagine".
 *
 * IMPORTANT: fal.ai model slugs and input field names change as providers update their
 * offerings. The slugs below are a best-effort snapshot — verify current slugs and input
 * schemas at https://fal.ai/models before relying on this in production.
 */

const fs = require("fs");
const path = require("path");

const FAL_API_BASE = "https://queue.fal.run";

// Best-effort model slugs on fal.ai — CONFIRM against https://fal.ai/models before production use.
const FAL_MODELS = {
  kling: process.env.FAL_KLING_MODEL || "fal-ai/kling-video/v3/pro/text-to-video",
  "grok-imagine": process.env.FAL_GROK_MODEL || "fal-ai/grok-imagine/text-to-video",
  seedance: process.env.FAL_SEEDANCE_MODEL || "fal-ai/bytedance/seedance/v2/text-to-video",
};
const FAL_LLM_MODEL = "openrouter/router";
const FAL_LLM_UNDERLYING = process.env.FAL_LLM_MODEL || "qwen/qwen-2.5-72b-instruct"; // cheap, strong-enough text model via OpenRouter

function buildScenePrompt(scene, style) {
  let p = `${scene.visual_description}. Visual style: ${style}.`;
  if (scene.dialogue_or_vo) {
    p += ` The subject speaks the following line naturally on camera or as voiceover: "${scene.dialogue_or_vo}"`;
  } else {
    p += ` No dialogue in this shot; ambient/product sound only.`;
  }
  return p;
}

async function falRequest(path_, options = {}) {
  const res = await fetch(`${FAL_API_BASE}${path_}`, {
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
    await new Promise((r) => setTimeout(r, 4000));
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

/* ------------------------- Script writing: fal.ai LLM ------------------------- */

/** Shared helper: call fal.ai's LLM router with a system+user prompt, return raw text. */
async function callFalLLM(systemInstruction, userContent) {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is not set — required for the fal.ai LLM");
  }
  const submitted = await falRequest(`/${FAL_LLM_MODEL}`, {
    method: "POST",
    body: JSON.stringify({
      model: FAL_LLM_UNDERLYING,
      prompt: `${systemInstruction}\n\n${userContent}`,
    }),
  });
  const result = await falPoll(submitted);
  const text = result.output || result.text || result.response || result.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`Could not find text output in fal.ai LLM response: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
}

async function writeScriptFal({ prompt, sceneCount, aspectRatio, tone }) {
  const systemInstruction = `You are a senior video ad creative director for product marketing.
Given a product/campaign brief, write a short marketing video broken into exactly ${sceneCount} scenes.
Each scene is a single continuous 8-second video-generation shot (no cuts within a scene).
Return ONLY strict JSON, no markdown fences, no commentary, matching this schema:
{
  "title": string,
  "scenes": [
    {
      "index": number,
      "visual_description": string,
      "dialogue_or_vo": string,
      "on_screen_text": string
    }
  ]
}
Constraints:
- Tone: ${tone}.
- Aspect ratio target: ${aspectRatio}.
- Keep each dialogue_or_vo short enough to be spoken naturally in ~8 seconds (roughly 18-22 words max).
- Make scene 1 a strong hook, and the final scene a clear call to action mentioning the product/brand.
- For scripts longer than 4 scenes, structure the middle scenes as a clear progression (e.g. problem → feature 1 → feature 2 → social proof/results) rather than repeating the same beat — each middle scene should earn its place by showing something new.
- Be specific and visual in visual_description so a video model can render it faithfully.
- Output ONLY the JSON object, nothing else.`;

  const cleaned = await callFalLLM(systemInstruction, `Product/campaign brief:\n${prompt}`);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse script JSON from fal.ai LLM output: " + cleaned.slice(0, 300));
  }
  return parsed;
}

/**
 * Turn a free-text modification request ("trim to the first 10 seconds, add a caption
 * saying X, make it square, mute the audio") into a structured edit plan that edit.js
 * can execute deterministically with ffmpeg.
 */
async function interpretEditPlanFal({ instructions, durationSeconds }) {
  const systemInstruction = `You convert a plain-English video editing request into a strict JSON edit plan.
The source video is ${durationSeconds.toFixed(1)} seconds long.
Return ONLY strict JSON, no markdown fences, no commentary, matching exactly this schema:
{
  "trim": { "start_seconds": number, "end_seconds": number } | null,
  "speed_multiplier": number,
  "target_aspect_ratio": "16:9" | "9:16" | "1:1" | null,
  "captions": [ { "text": string, "start_seconds": number, "end_seconds": number } ],
  "mute_audio": boolean,
  "fade_in_seconds": number,
  "fade_out_seconds": number,
  "summary": string
}
Rules:
- Only set fields the user actually asked for; leave others at their neutral default (trim: null, speed_multiplier: 1, target_aspect_ratio: null, captions: [], mute_audio: false, fade_in_seconds: 0, fade_out_seconds: 0).
- trim.end_seconds must not exceed ${durationSeconds.toFixed(1)} and must be greater than trim.start_seconds.
- If the user references relative timing ("first 10 seconds", "last 5 seconds"), convert it to absolute start_seconds/end_seconds against the ${durationSeconds.toFixed(1)}s duration.
- "summary" is a one-sentence plain-English restatement of exactly what will change, for the user to confirm.
- Output ONLY the JSON object, nothing else.`;

  const cleaned = await callFalLLM(systemInstruction, `Editing request:\n${instructions}`);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse edit plan JSON from fal.ai LLM output: " + cleaned.slice(0, 300));
  }
  return parsed;
}

/* ------------------------- Veo (direct via Gemini API) ------------------------- */

async function generateClipVeo(scene, { aspectRatio, style, ai }, jobDir) {
  const prompt = buildScenePrompt(scene, style);

  let operation = await ai.models.generateVideos({
    model: "veo-3.1-generate-preview",
    prompt,
    config: { aspectRatio },
  });

  while (!operation.done) {
    await new Promise((r) => setTimeout(r, 8000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) throw new Error(`Veo returned no video for scene ${scene.index}`);

  const outPath = path.join(jobDir, `scene-${String(scene.index).padStart(2, "0")}.mp4`);
  await ai.files.download({ file: video, downloadPath: outPath });
  return outPath;
}

/* ------------------------------ fal.ai video (Seedance / Kling / Grok Imagine) ------------------------------ */

async function generateClipFal(scene, { aspectRatio, style, providerId }, jobDir) {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is not set — required for the '" + providerId + "' provider (routed via fal.ai)");
  }
  const modelSlug = FAL_MODELS[providerId];
  if (!modelSlug) throw new Error(`No fal.ai model slug configured for provider "${providerId}"`);

  const prompt = buildScenePrompt(scene, style);

  const submitted = await falRequest(`/${modelSlug}`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      aspect_ratio: aspectRatio,
      duration: 8,
    }),
  });

  const result = await falPoll(submitted);
  const videoUrl =
    result.video?.url || result.video_url || result.output?.video?.url || result.data?.video?.url;

  if (!videoUrl) {
    throw new Error(
      `Could not find video URL in fal.ai response for scene ${scene.index}. Raw response: ${JSON.stringify(result).slice(0, 300)}`
    );
  }

  const outPath = path.join(jobDir, `scene-${String(scene.index).padStart(2, "0")}.mp4`);
  const videoRes = await fetch(videoUrl);
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

/* --------------------------------- Dispatchers --------------------------------- */

const VIDEO_PROVIDERS = {
  veo: { label: "Veo 3.1 (Google, direct — needs GEMINI_API_KEY)", generate: generateClipVeo },
  seedance: {
    label: "Seedance 2.0 (via fal.ai) — recommended",
    generate: (scene, opts, jobDir) => generateClipFal(scene, { ...opts, providerId: "seedance" }, jobDir),
  },
  kling: { label: "Kling 3.0 (via fal.ai)", generate: (scene, opts, jobDir) => generateClipFal(scene, { ...opts, providerId: "kling" }, jobDir) },
  "grok-imagine": {
    label: "Grok Imagine Video (via fal.ai) — fastest",
    generate: (scene, opts, jobDir) => generateClipFal(scene, { ...opts, providerId: "grok-imagine" }, jobDir),
  },
};

const SCRIPT_PROVIDERS = {
  gemini: { label: "Gemini 2.5 Flash (needs GEMINI_API_KEY)" }, // handled directly in server.js
  "fal-llm": { label: "Qwen via fal.ai (single-key setup)", write: writeScriptFal },
};

module.exports = { PROVIDERS: VIDEO_PROVIDERS, SCRIPT_PROVIDERS, interpretEditPlanFal };
