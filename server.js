/**
 * AI Product Marketing Video Generator
 * Prompt -> Script (Gemini or fal.ai LLM) -> Scenes -> video clips (Veo/Seedance/Kling/Grok Imagine) -> Stitched final video
 *
 * Requires:
 *   - Node 18+
 *   - ffmpeg installed and on PATH
 *   - Either GEMINI_API_KEY, or FAL_KEY, or both. FAL_KEY alone is enough to run the
 *     entire app single-key (fal-llm script provider + Seedance/Kling/Grok Imagine video).
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { execFile } = require("child_process");
const multer = require("multer");
const { PROVIDERS, SCRIPT_PROVIDERS, interpretEditPlanFal } = require("./providers");
const { applyBranding } = require("./branding");
const { generateHeyGenVideo, listAvatars, listVoices } = require("./heygen");
const { applyEditPlan, probeDuration } = require("./edit");
const { generateFalAvatarVideo } = require("./fal-avatar");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Combined uploader for the edit route: accepts a "video" field and an optional "logo" field,
// each validated against its own allowed mimetypes.
const uploadEditFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "video") {
      const ok = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"].includes(file.mimetype);
      return cb(ok ? null : new Error("Video must be MP4, MOV, WEBM, or MKV"), ok);
    }
    if (file.fieldname === "logo") {
      const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
      return cb(ok ? null : new Error("Logo must be PNG, JPG, or WEBP"), ok);
    }
    cb(new Error(`Unexpected upload field "${file.fieldname}"`), false);
  },
});

// Combined uploader for /api/generate: accepts an optional "logo" and an optional
// "avatar" (photo/short video, used by the fal.ai Avatar provider).
const uploadGenerateFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "logo") {
      const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
      return cb(ok ? null : new Error("Logo must be PNG, JPG, or WEBP"), ok);
    }
    if (file.fieldname === "avatar") {
      const ok = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime"].includes(file.mimetype);
      return cb(ok ? null : new Error("Avatar must be PNG/JPG/WEBP or an MP4/MOV video"), ok);
    }
    cb(new Error(`Unexpected upload field "${file.fieldname}"`), false);
  },
});

const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use("/output", express.static(OUTPUT_DIR));

if (!process.env.GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY not set — Veo provider and Gemini script-writing will be unavailable. Using fal.ai only is fine (set FAL_KEY).");
}
if (!process.env.FAL_KEY) {
  console.warn("FAL_KEY not set — Seedance/Kling/Grok Imagine and the fal.ai script-writing provider will be unavailable.");
}

// @google/genai is ESM-only, so it's loaded lazily via dynamic import — only when actually
// needed (Gemini script provider or Veo video provider). This keeps the app runnable on
// FAL_KEY alone without @google/genai's module format breaking startup.
let ai = null;
let aiInitPromise = null;
async function getAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (ai) return ai;
  if (!aiInitPromise) {
    aiInitPromise = import("@google/genai").then(({ GoogleGenAI }) => {
      ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      return ai;
    });
  }
  return aiInitPromise;
}

// In-memory job tracking (swap for a DB/queue in production)
const jobs = new Map();

const TEXT_MODEL = "gemini-2.5-flash";

app.get("/api/providers", (req, res) => {
  const video = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label }));
  if (process.env.FAL_KEY) {
    video.push({ id: "fal-avatar", label: "Fal.ai Avatar (upload your own face, real lip-sync, single key)" });
  }
  if (process.env.HEYGEN_API_KEY) {
    video.push({ id: "heygen", label: "HeyGen Avatar (real lip-synced avatar, needs avatar+voice pick)" });
  }
  res.json({
    video,
    script: Object.entries(SCRIPT_PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
  });
});

// Lets the frontend populate avatar/voice pickers from the connected HeyGen account
app.get("/api/heygen/avatars", async (req, res) => {
  try {
    if (!process.env.HEYGEN_API_KEY) return res.status(500).json({ error: "HEYGEN_API_KEY is not set" });
    res.json(await listAvatars());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/heygen/voices", async (req, res) => {
  try {
    if (!process.env.HEYGEN_API_KEY) return res.status(500).json({ error: "HEYGEN_API_KEY is not set" });
    res.json(await listVoices());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------
   Step 1: Turn a marketing prompt into a scene-by-scene script
--------------------------------------------------------- */
async function generateScriptGemini({ prompt, sceneCount, aspectRatio, tone }) {
  const client = await getAI();
  if (!client) throw new Error("GEMINI_API_KEY is not set — required for the Gemini script provider");

  const systemInstruction = `You are a senior video ad creative director for product marketing.
Given a product/campaign brief, write a short marketing video broken into exactly ${sceneCount} scenes.
Each scene is a single continuous 8-second video-generation shot (no cuts within a scene).
Return ONLY strict JSON, no markdown fences, no commentary, matching this schema:
{
  "title": string,
  "scenes": [
    {
      "index": number,
      "visual_description": string,   // cinematic description of setting, camera, subject, action, lighting, style
      "dialogue_or_vo": string,       // exact words spoken in this scene (voiceover or on-camera line), or "" if silent/music-only
      "on_screen_text": string        // optional short caption/text overlay, or ""
    }
  ]
}
Constraints:
- Tone: ${tone}.
- Aspect ratio target: ${aspectRatio}.
- Keep each dialogue_or_vo short enough to be spoken naturally in ~8 seconds (roughly 18-22 words max).
- Make scene 1 a strong hook, and the final scene a clear call to action mentioning the product/brand.
- For scripts longer than 4 scenes, structure the middle scenes as a clear progression (e.g. problem → feature 1 → feature 2 → social proof/results) rather than repeating the same beat — each middle scene should earn its place by showing something new.
- Be specific and visual in visual_description (camera angle, lighting, setting, product details) so a video model can render it faithfully.`;

  const response = await client.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
    },
  });

  const text = response.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Failed to parse script JSON from model output: " + text.slice(0, 300));
  }
  return parsed;
}

async function generateScript(opts, scriptProviderId) {
  if (scriptProviderId === "fal-llm") {
    return SCRIPT_PROVIDERS["fal-llm"].write(opts);
  }
  return generateScriptGemini(opts);
}

/* ---------------------------------------------------------
   Turn a free-text video-editing request into a structured, executable edit plan.
--------------------------------------------------------- */
async function interpretEditPlanGemini({ instructions, durationSeconds }) {
  const client = await getAI();
  if (!client) throw new Error("GEMINI_API_KEY is not set — required for the Gemini script provider");

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
- "summary" is a one-sentence plain-English restatement of exactly what will change, for the user to confirm.`;

  const response = await client.models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: "user", parts: [{ text: `Editing request:\n${instructions}` }] }],
    config: { systemInstruction, responseMimeType: "application/json" },
  });

  const text = response.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Failed to parse edit plan JSON from model output: " + text.slice(0, 300));
  }
  return parsed;
}

async function interpretEditPlan(opts, scriptProviderId) {
  if (scriptProviderId === "fal-llm") {
    return interpretEditPlanFal(opts);
  }
  return interpretEditPlanGemini(opts);
}

/* ---------------------------------------------------------
   Step 2: Generate one 8s video clip per scene, via the selected provider
--------------------------------------------------------- */
async function generateSceneClip(scene, { aspectRatio, style, providerId }, jobDir) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider "${providerId}"`);
  const client = providerId === "veo" ? await getAI() : null;
  return provider.generate(scene, { aspectRatio, style, ai: client }, jobDir);
}

/* ---------------------------------------------------------
   Run scene generations with limited concurrency so long (10-15 scene) videos
   don't take forever, while still respecting provider rate limits.
--------------------------------------------------------- */
async function generateScenesWithConcurrency(scenes, opts, jobDir, jobId, concurrency = 3) {
  const results = new Array(scenes.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < scenes.length) {
      const i = nextIndex++;
      const scene = scenes[i];
      results[i] = await generateSceneClip(scene, opts, jobDir);
      completed++;
      const job = jobs.get(jobId);
      jobs.set(jobId, {
        ...job,
        status: `generating_scene_${completed}_of_${scenes.length}`,
        progress: 15 + Math.round((completed / scenes.length) * 60),
      });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, scenes.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* ---------------------------------------------------------
   Step 3: Stitch all scene clips into one final video with ffmpeg
--------------------------------------------------------- */
function stitchClips(clipPaths, jobDir) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(jobDir, "concat-list.txt");
    const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(listFile, listContent);

    const finalPath = path.join(jobDir, "scenes.mp4");
    execFile(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalPath],
      (err) => {
        if (err) {
          // Fall back to re-encoding if streams don't match for a simple concat copy
          execFile(
            "ffmpeg",
            ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "libx264", "-c:a", "aac", finalPath],
            (err2) => {
              if (err2) return reject(err2);
              resolve(finalPath);
            }
          );
        } else {
          resolve(finalPath);
        }
      }
    );
  });
}

/* ---------------------------------------------------------
   API: kick off a generation job
--------------------------------------------------------- */
app.post("/api/generate", uploadGenerateFiles.fields([{ name: "logo", maxCount: 1 }, { name: "avatar", maxCount: 1 }]), async (req, res) => {
  const {
    prompt,
    sceneCount = 3,
    aspectRatio = "16:9",
    tone = "energetic and modern",
    style = "clean cinematic product-ad style, soft studio lighting, shallow depth of field",
    provider = "seedance",
    scriptProvider = process.env.GEMINI_API_KEY ? "gemini" : "fal-llm",
    tagline = "",
    avatarId = "",
    voiceId = "",
  } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }
  const sceneCountNum = Number(sceneCount);
  if (!Number.isInteger(sceneCountNum) || sceneCountNum < 1 || sceneCountNum > 15) {
    return res.status(400).json({ error: "sceneCount must be an integer between 1 and 15 (each scene is 8s, so 15 scenes ≈ 2 minutes)" });
  }
  const isHeyGen = provider === "heygen";
  const isFalAvatar = provider === "fal-avatar";
  if (!isHeyGen && !isFalAvatar && !PROVIDERS[provider]) {
    return res.status(400).json({ error: `Unknown video provider "${provider}"` });
  }
  if (!SCRIPT_PROVIDERS[scriptProvider]) {
    return res.status(400).json({ error: `Unknown script provider "${scriptProvider}"` });
  }
  if (scriptProvider === "gemini" && !process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY, required for the Gemini script provider" });
  }
  if (scriptProvider === "fal-llm" && !process.env.FAL_KEY) {
    return res.status(500).json({ error: "Server is missing FAL_KEY, required for the fal.ai script provider" });
  }
  if (provider === "veo" && !process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY, required for the Veo video provider" });
  }
  if (!isHeyGen && !isFalAvatar && provider !== "veo" && !process.env.FAL_KEY) {
    return res.status(500).json({ error: `Server is missing FAL_KEY, required for the "${provider}" video provider` });
  }
  if (isHeyGen) {
    if (!process.env.HEYGEN_API_KEY) {
      return res.status(500).json({ error: "Server is missing HEYGEN_API_KEY, required for the HeyGen avatar provider" });
    }
    if (!avatarId || !voiceId) {
      return res.status(400).json({ error: "avatarId and voiceId are required for the HeyGen provider — pick them from the avatar/voice list" });
    }
  }
  if (isFalAvatar) {
    if (!process.env.FAL_KEY) {
      return res.status(500).json({ error: "Server is missing FAL_KEY, required for the fal.ai Avatar provider" });
    }
    if (!req.files?.avatar?.[0]) {
      return res.status(400).json({ error: "An avatar photo or short video is required for the fal.ai Avatar provider" });
    }
  }

  const jobId = uuidv4();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Save the uploaded logo (if any) into the job dir so ffmpeg can composite it later
  const logoFile = req.files?.logo?.[0];
  let logoPath = null;
  if (logoFile) {
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[logoFile.mimetype] || ".png";
    logoPath = path.join(jobDir, `logo${ext}`);
    fs.writeFileSync(logoPath, logoFile.buffer);
  }

  const avatarFile = req.files?.avatar?.[0];

  jobs.set(jobId, { status: "writing_script", progress: 5 });
  res.json({ jobId });

  // Run the pipeline in the background; client polls /api/status/:jobId
  (async () => {
    try {
      const script = await generateScript({ prompt, sceneCount: sceneCountNum, aspectRatio, tone }, scriptProvider);
      fs.writeFileSync(path.join(jobDir, "script.json"), JSON.stringify(script, null, 2));

      let stitchedPath;
      if (isHeyGen) {
        jobs.set(jobId, { status: "generating_avatar_video", progress: 20, script });
        stitchedPath = await generateHeyGenVideo({ script, avatarId, voiceId, aspectRatio, jobDir });
      } else if (isFalAvatar) {
        jobs.set(jobId, { status: "generating_avatar_video", progress: 20, script });
        stitchedPath = await generateFalAvatarVideo({
          script,
          avatarBuffer: avatarFile.buffer,
          avatarMimeType: avatarFile.mimetype,
          jobDir,
        });
      } else {
        jobs.set(jobId, { status: "generating_scenes", progress: 15, script });
        const clipPaths = await generateScenesWithConcurrency(
          script.scenes,
          { aspectRatio, style, providerId: provider },
          jobDir,
          jobId,
          3 // concurrent scene generations — tune down if you hit provider rate limits
        );

        jobs.set(jobId, { status: "stitching", progress: 80, script });
        stitchedPath = await stitchClips(clipPaths, jobDir);
      }

      let finalPath = stitchedPath;
      if (logoPath) {
        jobs.set(jobId, { status: "branding", progress: 90, script });
        finalPath = await applyBranding({
          stitchedPath,
          logoPath,
          tagline,
          aspectRatio,
          jobDir,
        });
      }

      jobs.set(jobId, {
        status: "done",
        progress: 100,
        script,
        videoUrl: `/output/${jobId}/${path.basename(finalPath)}`,
      });
    } catch (err) {
      console.error(err);
      jobs.set(jobId, { status: "error", progress: 0, error: err.message });
    }
  })();
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(job);
});

/* ---------------------------------------------------------
   API: upload an existing video + a plain-English modification request,
   and apply the requested edits to it.
--------------------------------------------------------- */
app.post(
  "/api/edit-video",
  uploadEditFiles.fields([
    { name: "video", maxCount: 1 },
    { name: "logo", maxCount: 1 },
  ]),
  async (req, res) => {
    const {
      instructions = "",
      tagline = "",
      scriptProvider = process.env.GEMINI_API_KEY ? "gemini" : "fal-llm",
    } = req.body;

    const videoFile = req.files?.video?.[0];
    const logoFile = req.files?.logo?.[0];

    if (!videoFile) {
      return res.status(400).json({ error: "A video file is required" });
    }
    if (!instructions || !instructions.trim()) {
      return res.status(400).json({ error: "Describe what changes you want made to the video" });
    }
    if (!SCRIPT_PROVIDERS[scriptProvider]) {
      return res.status(400).json({ error: `Unknown script provider "${scriptProvider}"` });
    }
    if (scriptProvider === "gemini" && !process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Server is missing GEMINI_API_KEY, required for the Gemini script provider" });
    }
    if (scriptProvider === "fal-llm" && !process.env.FAL_KEY) {
      return res.status(500).json({ error: "Server is missing FAL_KEY, required for the fal.ai script provider" });
    }

    const jobId = uuidv4();
    const jobDir = path.join(OUTPUT_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const videoExt = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv" }[videoFile.mimetype] || ".mp4";
    const inputPath = path.join(jobDir, `input${videoExt}`);
    fs.writeFileSync(inputPath, videoFile.buffer);

    let logoPath = null;
    if (logoFile) {
      const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[logoFile.mimetype] || ".png";
      logoPath = path.join(jobDir, `logo${ext}`);
      fs.writeFileSync(logoPath, logoFile.buffer);
    }

    jobs.set(jobId, { status: "analyzing_video", progress: 10 });
    res.json({ jobId });

    (async () => {
      try {
        const durationSeconds = await probeDuration(inputPath);

        jobs.set(jobId, { status: "planning_edits", progress: 25 });
        const plan = await interpretEditPlan({ instructions, durationSeconds }, scriptProvider);
        fs.writeFileSync(path.join(jobDir, "edit-plan.json"), JSON.stringify(plan, null, 2));

        jobs.set(jobId, { status: "applying_edits", progress: 45, plan });
        const editedPath = await applyEditPlan({ inputPath, plan, jobDir });

        let finalPath = editedPath;
        if (logoPath) {
          jobs.set(jobId, { status: "branding", progress: 85, plan });
          finalPath = await applyBranding({
            stitchedPath: editedPath,
            logoPath,
            tagline,
            aspectRatio: plan.target_aspect_ratio || "16:9",
            jobDir,
          });
        }

        jobs.set(jobId, {
          status: "done",
          progress: 100,
          plan,
          videoUrl: `/output/${jobId}/${path.basename(finalPath)}`,
        });
      } catch (err) {
        console.error(err);
        jobs.set(jobId, { status: "error", progress: 0, error: err.message });
      }
    })();
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI video generator listening on http://localhost:${PORT}`));
