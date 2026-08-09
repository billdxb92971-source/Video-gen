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
const { PROVIDERS, SCRIPT_PROVIDERS } = require("./providers");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
  res.json({
    video: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
    script: Object.entries(SCRIPT_PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
  });
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
   Step 2: Generate one 8s video clip per scene, via the selected provider
--------------------------------------------------------- */
async function generateSceneClip(scene, { aspectRatio, style, providerId }, jobDir) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider "${providerId}"`);
  const client = providerId === "veo" ? await getAI() : null;
  return provider.generate(scene, { aspectRatio, style, ai: client }, jobDir);
}

/* ---------------------------------------------------------
   Step 3: Stitch all scene clips into one final video with ffmpeg
--------------------------------------------------------- */
function stitchClips(clipPaths, jobDir) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(jobDir, "concat-list.txt");
    const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    fs.writeFileSync(listFile, listContent);

    const finalPath = path.join(jobDir, "final.mp4");
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
app.post("/api/generate", async (req, res) => {
  const {
    prompt,
    sceneCount = 3,
    aspectRatio = "16:9",
    tone = "energetic and modern",
    style = "clean cinematic product-ad style, soft studio lighting, shallow depth of field",
    provider = "seedance",
    scriptProvider = process.env.GEMINI_API_KEY ? "gemini" : "fal-llm",
  } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (!PROVIDERS[provider]) {
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
  if (provider !== "veo" && !process.env.FAL_KEY) {
    return res.status(500).json({ error: `Server is missing FAL_KEY, required for the "${provider}" video provider` });
  }

  const jobId = uuidv4();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs.set(jobId, { status: "writing_script", progress: 5 });
  res.json({ jobId });

  // Run the pipeline in the background; client polls /api/status/:jobId
  (async () => {
    try {
      const script = await generateScript({ prompt, sceneCount: Number(sceneCount), aspectRatio, tone }, scriptProvider);
      fs.writeFileSync(path.join(jobDir, "script.json"), JSON.stringify(script, null, 2));
      jobs.set(jobId, { status: "generating_scenes", progress: 15, script });

      const clipPaths = [];
      for (const scene of script.scenes) {
        jobs.set(jobId, {
          status: `generating_scene_${scene.index}_of_${script.scenes.length}`,
          progress: 15 + Math.round((scene.index / script.scenes.length) * 65),
          script,
        });
        const clipPath = await generateSceneClip(scene, { aspectRatio, style, providerId: provider }, jobDir);
        clipPaths.push(clipPath);
      }

      jobs.set(jobId, { status: "stitching", progress: 90, script });
      const finalPath = await stitchClips(clipPaths, jobDir);

      jobs.set(jobId, {
        status: "done",
        progress: 100,
        script,
        videoUrl: `/output/${jobId}/final.mp4`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI video generator listening on http://localhost:${PORT}`));
