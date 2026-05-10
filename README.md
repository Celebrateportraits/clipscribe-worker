# clipscribe-worker

External worker for ClipScribe AI. Downloads videos with **yt-dlp**, extracts frames + audio with **ffmpeg**, optionally transcribes with **Groq Whisper**, and returns frames as base64 data URLs.

## Endpoint

`POST /process`

### Request
```json
{
  "url": "https://www.instagram.com/p/...",
  "platform": "auto|youtube|tiktok|instagram|facebook",
  "mode": "hook|ad|short|deep",
  "frameWidth": 512
}
```
Optional header (if `SHARED_SECRET` is set): `Authorization: Bearer <SHARED_SECRET>`

### Response
```json
{
  "frames": [
    { "name": "f_0001.jpg", "timestamp": "00:01", "t": 1.0, "dataUrl": "data:image/jpeg;base64,..." }
  ],
  "transcript": "[0.0s] ...",
  "duration": "42",
  "durationSeconds": 42,
  "resolution": "720x1280",
  "videoReport": "# Source ..."
}
```

## Mode → frame density

| mode  | fps | window |
|-------|-----|--------|
| hook  | 4   | first 10s |
| ad    | 1   | first 30s |
| short | 1   | first 60s |
| deep  | 1   | full video |

## Local run
```
docker build -t clipscribe-worker .
docker run --rm -p 8080:8080 -e GROQ_API_KEY=... clipscribe-worker
curl -X POST localhost:8080/process -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","mode":"hook"}'
```

## Deploy to Render

1. Push this folder to a GitHub repo (e.g. `clipscribe-worker`).
2. On https://dashboard.render.com → **New +** → **Web Service**.
3. Connect the repo. Render auto-detects the `Dockerfile`.
4. Settings:
   - **Runtime**: Docker
   - **Region**: any
   - **Instance Type**: Starter (512MB) is fine for short clips; use Standard for longer videos.
   - **Health Check Path**: `/health`
5. **Environment** variables:
   - `GROQ_API_KEY` — your Groq key (optional, enables transcripts)
   - `SHARED_SECRET` — any random string (optional, locks the endpoint)
6. Click **Create Web Service**. Wait for the first build (~3–5 min, ffmpeg + yt-dlp install).
7. Copy the public URL, e.g. `https://clipscribe-worker.onrender.com`.

## Wire into Lovable

In the Lovable project, add a secret:

- **Name**: `WORKER_URL`
- **Value**: `https://clipscribe-worker.onrender.com` (no trailing slash)

If you set `SHARED_SECRET` on Render, also add:

- **Name**: `WORKER_SECRET`
- **Value**: same value as `SHARED_SECRET`

(See note below — the Lovable server fn currently doesn't send the bearer header. Leave `SHARED_SECRET` blank unless you also update `fetchFromWorker` to forward it.)

## Notes / limits

- Render free tier sleeps after 15 min idle → first request may take ~30s. Use Starter ($7/mo) for always-on.
- Instagram / TikTok sometimes require cookies. If yt-dlp returns "login required", mount a `cookies.txt` and add `--cookies /app/cookies.txt` to the yt-dlp args in `src/server.js`.
- yt-dlp is pinned to latest at build time; redeploy occasionally to refresh extractors.
