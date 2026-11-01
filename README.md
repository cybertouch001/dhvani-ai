# Dhvani AI

Voice-cloning app: record 10–15 seconds of your voice, then type any Hindi or English text and hear it in your voice as an MP3.
Built on the open-source [OmniVoice](https://github.com/k2-fsa/OmniVoice) model (Apache-2.0).

- **Web app:** https://dhvani.sites.tab.bot
- **Android app (APK):** https://dhvani.sites.tab.bot/download
- **Config (current server):** https://dhvani.sites.tab.bot/config.json

## How it fits together

```
 Android app (WebView shell)  ─┐
                               ├──>  dhvani.sites.tab.bot  (static app + Worker)
 Browser (web app)            ─┘        │  /api/*  → proxied to the current backend URL (stored in D1)
                                         ▼
                              Backend (FastAPI + OmniVoice, one model in memory, one job at a time)
                              today: a CPU box behind a Cloudflare quick tunnel
                              later: Hugging Face Space / GPU server / own VPS — same Docker image
```

The apps only ever talk to `https://dhvani.sites.tab.bot/api/...`. **Moving the backend never needs a new app build** —
point the site at the new server URL (see "Moving the backend").

## Folders

| Path | What |
|---|---|
| `server/app.py` | Backend API (FastAPI). Model loaded once at startup. |
| `site/` | Web app + `_worker.js` (API proxy, config, APK download). |
| `app/android/` | Android app: native WebView shell (mic permission, file picker, MP3 download via DownloadManager, share sheet). |
| `start.sh` | Start/restart backend + tunnel and re-point the site. |
| `Dockerfile` | Same backend for Hugging Face Spaces / GPU / VPS. |
| `deploy/` | systemd timer that runs `start.sh` at boot and every 2 minutes (self-healing). |

## API

All endpoints except `/health`, `/login` and signed audio links need `Authorization: Bearer <token>`.

| Method | Path | |
|---|---|---|
| GET | `/health` | status, model ready, queue length |
| POST | `/login` `{password, device}` | app password → device token |
| GET | `/voices` | saved voices |
| POST | `/voices` (multipart: `file`, `name`, `lang`, `ref_text`, `consent=1`) | save a voice (3 s – 5 min recording; the first 12 s of speech are used) |
| DELETE | `/voices/{id}` | delete a voice |
| POST | `/tts` `{voice_id, text, lang: hi\|en\|auto, speed: 0.6–1.5, fast: bool}` | queue a job → `{id, estimate_seconds}` |
| GET | `/jobs/{id}` | `queued` / `running` / `done` / `error`, `progress` 0–1, `audio_url` when done |
| GET | `/jobs/{id}/audio?exp&sig[&download=1]` | MP3 (signed link, valid 24 h) |
| GET | `/jobs` · DELETE `/jobs/{id}` | history |

Limits (env-configurable): text ≤ 1500 characters (split into sentences and joined), upload ≤ 10 MB,
40 jobs/hour per device, queue ≤ 12 jobs, ≤ 30 saved voices, 10 login attempts / 10 min per IP.
Long text is split on sentence ends (`.` `!` `?` `।`) into ~220-character pieces, generated one after another and joined.

## Running it (current box)

```
./start.sh            # start whatever isn't running and re-point the site (safe to repeat)
./start.sh restart    # fresh server + fresh tunnel
./start.sh status
./start.sh stop
```

Secrets live only in `private/secrets.json` on the server (app password, link-signing key, site admin token) — never in this repo.
Logs: `logs/server.log`, `logs/tunnel.log`.

**Limits of the current setup**
- The quick tunnel (`trycloudflare.com`) has no uptime guarantee and gets a new address on every restart; `start.sh` updates the site automatically.
- The box sleeps after about 1 hour without activity; while it sleeps the apps show "Server offline". Nothing restarts it automatically on wake — run `start.sh` again.
- CPU only: roughly 20–25 s per sentence in normal mode, ~10–12 s in fast mode; one job at a time.

## Moving the backend (Hugging Face Space / GPU / own server)

1. Run the Docker image anywhere:
   - **Hugging Face Space:** create a Space → SDK *Docker* → upload `Dockerfile` and `server/`, and put this at the top of the Space's README:
     ```
     ---
     title: Dhvani AI
     sdk: docker
     app_port: 7860
     ---
     ```
     In the Space settings add secrets `DHVANI_APP_PASSWORD` and `DHVANI_SIGNING_KEY`. Free *CPU basic* (2 vCPU) works but is several times slower than this box; without paid persistent storage, saved voices are lost when the Space restarts.
   - **GPU server:** `docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu128 -t dhvani . && docker run --gpus all -p 7860:7860 -e DHVANI_APP_PASSWORD=... -v dhvani-data:/data dhvani`
   - **Own VPS (CPU):** `docker build -t dhvani . && docker run -p 7860:7860 -e DHVANI_APP_PASSWORD=... -v dhvani-data:/data dhvani` behind HTTPS (Caddy/nginx or a named Cloudflare tunnel).
2. Point the site at it (admin token from `private/secrets.json`; the site's `_worker.js` holds only its SHA-256 — set `ADMIN_TOKEN_SHA256` when deploying your own copy):
   ```
   curl -X POST https://dhvani.sites.tab.bot/admin/server -H "x-admin-token: $TOKEN" \
        -H 'content-type: application/json' -d '{"url":"https://YOUR-SERVER"}'
   ```
   The web and Android apps pick it up on the next request. No rebuild.

## Android build

```
cd app/android
export JAVA_HOME=/path/to/jdk17+ ANDROID_HOME=/path/to/android-sdk
./gradlew assembleRelease     # signing: app/android/../../kit/signing.properties or env DHVANI_SIGNING_PROPS
```
Package `bot.tab.sites.dhvani`, min Android 7.0 (API 24), target API 35. Every update must be signed with the same key (kept privately, not in this repo).

## Consent

The app asks the user to confirm the recorded voice is their own or that they have the speaker's permission. Please don't clone voices without permission.

## License

App code: MIT. OmniVoice model and code: Apache-2.0 (k2-fsa).
