# AI Product Video Generator

Prompt → marketing script → AI-generated video scenes (with native spoken dialogue) → one stitched final video.

**Runs on a single `FAL_KEY` if you want** — no Gemini account required. Pick a script writer and a video model per generation from the dropdowns:

**Script writer**

| Provider | Routed via | Notes |
|---|---|---|
| **fal.ai LLM (Qwen)** (default) | fal.ai | Single-key setup — same `FAL_KEY` as the video models |
| Gemini 2.5 Flash | Gemini API directly | Optional extra, needs `GEMINI_API_KEY` |

**Video model**

| Provider | Routed via | Notes |
|---|---|---|
| **Seedance 2.0** (default) | fal.ai | Best quality/cost balance — true 1080p, joint audio-video generation for tighter lip-sync, ~$0.02–0.03/sec |
| **Kling 3.0** | fal.ai | Strong on complex motion, ~$0.10/sec |
| **Grok Imagine Video** | fal.ai | Fastest generation, good for iterating many variations quickly, ~$0.05/sec |
| Veo 3.1 | Gemini API directly | Optional extra, needs `GEMINI_API_KEY`, best 4K+audio quality, ~$0.15/sec |

`ffmpeg` stitches the generated scenes into the final ad regardless of which models made them.

## Real avatar lip-sync — two ways

Everything else in this app (Veo/Seedance/Kling/Grok Imagine) is generative video — AI invents the scene and "presenter" fresh each time. If you need what HeyGen actually does — a **specific chosen face, precisely lip-synced to your exact script text** — there are two real options here, not scene-generation approximations:

**Option A: fal.ai Avatar (single key, upload your own face)**
- Uses only `FAL_KEY` — no separate account. Pick **"Fal.ai Avatar"** in the dropdown, upload a face photo or a few seconds of video.
- All script dialogue is combined into one narration, read by fal.ai TTS, then lip-synced onto your uploaded face via `fal-ai/sync-lipsync/v3` (default) — one continuous video, no clip stitching.
- That model only accepts video input, not photos — if you upload a photo, it's automatically converted into a short silent looping video with ffmpeg first, so photo uploads still work end-to-end.
- Honest limitation: quality on a generic uploaded photo/clip varies more than HeyGen's professionally rigged avatars — a short, well-lit, front-facing video tends to outperform a converted still photo, since there's real head/face motion for the model to work with. `FAL_TTS_MODEL`/`FAL_LIPSYNC_MODEL` are best-effort slugs, verify at https://fal.ai/models if a call fails.

**Option B: HeyGen (their own avatars, separate account/billing)**
- Set `HEYGEN_API_KEY` (from app.heygen.com → Settings → API) and a "HeyGen Avatar" option appears in the dropdown.
- Selecting it shows Avatar and Voice pickers, populated live from your HeyGen account via `/api/heygen/avatars` and `/api/heygen/voices`.
- Your script's scenes become HeyGen "video inputs" — HeyGen renders and joins them into one continuous video itself, with a professionally-trained avatar precisely synced to each line.
- Uses HeyGen's own paid per-second API billing — separate from your `FAL_KEY`/`GEMINI_API_KEY` usage.

Both bypass the 8-second-clip + ffmpeg-stitch pipeline entirely, and your logo/end-card branding still applies on top of either, same as any other provider.

## Modifying an existing video

Switch to the **"Edit existing video"** tab to upload a video you already have (MP4/MOV/WEBM/MKV, up to 300MB) and describe changes in plain English — e.g. *"trim to the first 15 seconds, make it vertical for Reels, add a caption saying 'New Feature' at the start, mute the audio, and fade in."*

How it works:
1. Your instructions + the video's actual duration go to an LLM (same script-writer choice as the generate tab — fal.ai Qwen or Gemini), which returns a structured edit plan (`edit.js`'s schema: trim, speed, aspect ratio, captions, mute, fades) rather than freeform text.
2. `edit.js` executes that plan deterministically with ffmpeg, one operation at a time.
3. If you attach a logo, the same `branding.js` watermark + end-card pass from the generate tab runs on top.
4. The plan's one-line `summary` is shown with the result so you can confirm what actually changed.

This only *modifies* the video you upload — it doesn't regenerate footage or extend it with new AI-generated scenes. For adding new scenes to an existing video, use the generate tab to make new scenes and stitch them in manually, or ask for that as an extension (see below).

## Adding your logo

Upload a logo (PNG/JPG/WEBP) in the app and optionally add a tagline. Note this is **not** done by asking the AI video model to draw your logo — generative video models are unreliable at reproducing exact logos/text (they tend to warp or approximate them). Instead, `branding.js` composites your actual logo file onto the finished video with ffmpeg:

1. A semi-transparent watermark in the bottom-right corner for the whole video
2. A branded end-card appended after the last scene — your logo centered on a dark background, with your tagline underneath

This guarantees a crisp, accurate logo instead of a generative approximation.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — for a single-key setup, just set:
#   FAL_KEY - https://fal.ai/dashboard/keys
# (GEMINI_API_KEY is optional — only needed if you want the Gemini/Veo options too)
```

**Note on fal.ai model slugs**: `providers.js` has best-effort model slugs for Seedance, Kling, Grok Imagine, and the LLM router as of writing. fal.ai model slugs and input schemas change as they add/update models — check https://fal.ai/models and update `FAL_SEEDANCE_MODEL` / `FAL_KLING_MODEL` / `FAL_GROK_MODEL` / `FAL_LLM_MODEL` in `.env` (or the defaults in `providers.js`) if a provider call fails.

Install ffmpeg (required for stitching clips):
```bash
# macOS
brew install ffmpeg
# Ubuntu/Debian
sudo apt-get install ffmpeg
```

Run:
```bash
npm start
```

Open http://localhost:3000, describe your product/video, pick scene count & aspect ratio, and generate.

## How it works

1. **Script** — your prompt goes to whichever script writer you picked, which returns a JSON storyboard: N scenes, each with a visual description, spoken line, and optional on-screen text. Scene 1 is a hook, the last scene is the CTA.
2. **Scenes** — each scene is sent to the video model you picked (`providers.js`). Whichever model you choose renders an 8-second clip with native audio/dialogue baked in — no separate TTS/lip-sync step needed.
3. **Stitch** — once all clips are downloaded, ffmpeg concatenates them into `scenes.mp4`.
4. **Brand** (if a logo was uploaded) — `branding.js` watermarks `scenes.mp4` and appends a generated end-card, producing `final.mp4`. Without a logo, `scenes.mp4` is served as the final result directly.
5. The frontend polls `/api/status/:jobId` and shows progress, then plays/downloads the finished video.

## Adding another provider

`providers.js` exports `PROVIDERS` (video) and `SCRIPT_PROVIDERS` (script). Each video entry is `{ label, generate(scene, opts, jobDir) }`; each fal.ai-based script entry is `{ label, write(opts) }`. To add a new model (e.g. Runway, or a HeyGen avatar for lip-synced presenters), add a new adapter function following the same pattern as `generateClipFal`, register it in the relevant map, and it'll automatically show up in the dropdown via `/api/providers`.

## Important: how the generative-scene models differ from HeyGen

The Veo/Seedance/Kling/Grok Imagine path (the default) is a genuinely different architecture from HeyGen — worth knowing if you use that path instead of the HeyGen integration above:

| | HeyGen (real avatar path) | Generative-scene models (Veo/Seedance/Kling/Grok Imagine) |
|---|---|---|
| Avatar | You pick a specific reusable avatar, lip-synced precisely | No fixed avatar; each scene's "presenter" is generated by the model and can vary |
| Script accuracy | Exact word-for-word lip sync to your script | Models perform the line naturally but aren't guaranteed word-perfect lip sync |
| Clip length | Continuous, any length | Hard-capped at 8 seconds per clip, then stitched |
| Consistency across scenes | Same avatar every time | Character/style consistency across scenes is best-effort |
| Cost | Per-second HeyGen billing | Per-clip generation cost, varies by model — see table above |

## Deploying to Render

This repo includes a `Dockerfile` (installs ffmpeg, which Render's native Node runtime doesn't have) and a `render.yaml` blueprint.

**Option A — Blueprint (recommended, one click):**
1. Push this project to a GitHub/GitLab repo.
2. In Render: **New → Blueprint**, point it at the repo. Render reads `render.yaml` automatically.
3. When prompted, set the env var `FAL_KEY` (and `GEMINI_API_KEY` if you're using it) — these are marked `sync: false` so Render asks you to fill them in rather than storing them in the repo.
4. Deploy. Render builds the Docker image and starts the service.

**Option B — Manual Web Service settings** (if not using the blueprint):
| Setting | Value |
|---|---|
| Environment | **Docker** (not Node — needed for ffmpeg) |
| Dockerfile path | `./Dockerfile` |
| Build/Start commands | leave blank — the Dockerfile's `CMD` handles it |
| Instance type | Starter is fine to begin with |
| Health check path | `/` |
| Environment variables | `FAL_KEY` (required), `GEMINI_API_KEY` (optional), `HEYGEN_API_KEY` (optional) |
| Port | leave default — server reads Render's `$PORT` automatically |

**Storage note:** generated videos are written to local disk (`/app/output`). Render's web service disk isn't guaranteed to persist across deploys/restarts and isn't shared if you scale to multiple instances. The `render.yaml` attaches a small persistent disk at `/app/output` to survive restarts on a single instance — if you plan to scale horizontally or want videos to survive redeploys long-term, swap the local `fs.writeFileSync` calls in `providers.js`/`server.js` for an object storage upload (S3, Cloudflare R2, etc.) instead.

## Extending this

- `heygen.js` currently uses text-to-speech via HeyGen's built-in voices. If you want to reuse a specific recorded voice, HeyGen also supports voice cloning/audio-driven avatars — see their docs and swap the `voice` block in `generateHeyGenVideo`.
- `edit.js`'s plan schema is intentionally small (trim/speed/aspect/captions/mute/fades). To support more editing requests (background music, color grading, crop to a custom region, splicing in a second clip), extend the plan schema in both `interpretEditPlanFal`/`interpretEditPlanGemini` and add a matching `stepX` function in `edit.js`.
- Add a reference-image feature to keep a consistent product/character look across the generative-scene models (Seedance supports up to 9 reference images).
- Add a job queue (BullMQ/Redis) instead of the in-memory `Map` for production use.
- Persist jobs/videos to cloud storage instead of local disk.
