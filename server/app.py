#!/usr/bin/env python3
"""Dhvani AI backend - OmniVoice voice cloning API (CPU or GPU).

Env (all optional):
  DHVANI_DATA      data dir (voices, jobs)            default ../data
  DHVANI_PRIVATE   private dir (secrets)              default ../private
  DHVANI_MODEL     OmniVoice model dir or HF repo id  default /home/user/work/omnivoice/model or k2-fsa/OmniVoice
  DHVANI_DEVICE    cpu | cuda                          default auto
  DHVANI_APP_PASSWORD  app password (else read from / generated into $DHVANI_PRIVATE/secrets.json)
  DHVANI_SIGNING_KEY   secret for signed audio links (else generated into secrets.json)
  DHVANI_MAX_CHARS, DHVANI_MAX_UPLOAD_MB, DHVANI_JOBS_PER_HOUR, DHVANI_MAX_VOICES
"""
import hashlib, hmac, json, os, re, secrets, shutil, subprocess, sys, tempfile, threading, time, uuid
from collections import deque
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DHVANI_DATA", HERE.parent / "data"))
PRIVATE = Path(os.environ.get("DHVANI_PRIVATE", HERE.parent / "private"))
LOCAL_MODEL = "/home/user/work/omnivoice/model"
MODEL = os.environ.get("DHVANI_MODEL") or (LOCAL_MODEL if os.path.isdir(LOCAL_MODEL) else "k2-fsa/OmniVoice")
MAX_CHARS = int(os.environ.get("DHVANI_MAX_CHARS", 1500))
MAX_UPLOAD = int(os.environ.get("DHVANI_MAX_UPLOAD_MB", 10)) * 1024 * 1024
JOBS_PER_HOUR = int(os.environ.get("DHVANI_JOBS_PER_HOUR", 40))
MAX_VOICES = int(os.environ.get("DHVANI_MAX_VOICES", 30))
MAX_QUEUE = 12
VERSION = "1.0.0"

VOICES = DATA / "voices"; JOBS = DATA / "jobs"
for d in (VOICES, JOBS, PRIVATE):
    d.mkdir(parents=True, exist_ok=True)

# ---------------- secrets ----------------
SECRETS_FILE = PRIVATE / "secrets.json"
def load_secrets():
    s = {}
    if SECRETS_FILE.exists():
        s = json.loads(SECRETS_FILE.read_text())
    changed = False
    if os.environ.get("DHVANI_APP_PASSWORD"):
        s["app_password"] = os.environ["DHVANI_APP_PASSWORD"]
    if not s.get("app_password"):
        s["app_password"] = secrets.token_urlsafe(9); changed = True
    if os.environ.get("DHVANI_SIGNING_KEY"):
        s["signing_key"] = os.environ["DHVANI_SIGNING_KEY"]
    if not s.get("signing_key"):
        s["signing_key"] = secrets.token_hex(32); changed = True
    if changed:
        try:
            SECRETS_FILE.write_text(json.dumps(s, indent=1)); os.chmod(SECRETS_FILE, 0o600)
        except OSError:
            pass
    return s
SECRETS = load_secrets()
SIGN_KEY = SECRETS["signing_key"].encode()

DEVICES_FILE = DATA / "devices.json"   # token hashes only
_dev_lock = threading.Lock()
def _devices():
    return json.loads(DEVICES_FILE.read_text()) if DEVICES_FILE.exists() else {}
def _save_devices(d):
    tmp = DEVICES_FILE.with_suffix(".tmp"); tmp.write_text(json.dumps(d, indent=1)); tmp.replace(DEVICES_FILE)
def _h(t): return hashlib.sha256(t.encode()).hexdigest()

def auth(token):
    if not token:
        raise HTTPException(401, "login required")
    t = token.removeprefix("Bearer ").strip()
    d = _devices().get(_h(t))
    if not d or d.get("revoked"):
        raise HTTPException(401, "invalid or revoked token")
    return _h(t)

def sign(path, ttl=24 * 3600):
    exp = int(time.time()) + ttl
    sig = hmac.new(SIGN_KEY, f"{path}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{path}?exp={exp}&sig={sig}"
def check_sig(path, exp, sig):
    try: exp = int(exp)
    except Exception: return False
    if exp < time.time(): return False
    good = hmac.new(SIGN_KEY, f"{path}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(good, sig or "")

# ---------------- rate limiting ----------------
_hits = {}
_fail = deque()
def rate(key, limit, window=3600):
    q = _hits.setdefault(key, deque()); now = time.time()
    while q and q[0] < now - window: q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "limit reached, try later")
    q.append(now)

# ---------------- model ----------------
STATE = {"model": None, "loading": True, "error": None, "loaded_at": None, "device": None}
GPU_LOCK = threading.Lock()   # one model call at a time

def load_model():
    try:
        import torch
        from omnivoice import OmniVoice
        dev = os.environ.get("DHVANI_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
        if dev == "cpu": torch.set_num_threads(os.cpu_count())
        t0 = time.time()
        dtype = torch.float16 if dev == "cuda" else torch.float32
        STATE["model"] = OmniVoice.from_pretrained(MODEL, device_map=dev, dtype=dtype)
        STATE.update(loading=False, loaded_at=time.time(), device=dev, load_s=round(time.time() - t0, 1))
        print(f"[model] loaded on {dev} in {time.time()-t0:.1f}s", flush=True)
    except Exception as e:
        STATE.update(loading=False, error=repr(e)); print("[model] load failed", e, flush=True)

# ---------------- audio helpers ----------------
def ffmpeg(*args, timeout=120):
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", *args], check=True, timeout=timeout,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def probe_duration(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                       capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    try: return float(r.stdout.strip())
    except Exception: return 0.0

def to_ref_wav(src, dst, max_sec=12):
    af = ("highpass=f=70,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,"
          "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,areverse,loudnorm=I=-20")
    ffmpeg("-i", str(src), "-af", af, "-t", str(max_sec), "-ac", "1", "-ar", "24000", str(dst))

def transcribe(wav, lang):
    # 1) Tab model proxy on the original box (accurate on Hindi); 2) local faster-whisper if installed
    cap = Path("/home/user/tab/.model-capability.json")
    if cap.exists():
        try:
            import requests
            mc = json.loads(cap.read_text())
            data = {"model": "gpt-4o-transcribe"}
            if lang in ("hi", "en"): data["language"] = lang
            with open(wav, "rb") as fh:
                r = requests.post(mc["base_url"] + "/openai/v1/audio/transcriptions",
                                  headers={"Authorization": "Bearer " + mc["token"]},
                                  files={"file": ("ref.wav", fh)}, data=data, timeout=90)
            r.raise_for_status(); return r.json()["text"].strip()
        except Exception as e:
            print("[asr] remote failed:", e, flush=True)
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel(os.environ.get("DHVANI_WHISPER", "small"), device="cpu", compute_type="int8")
        segs, _ = m.transcribe(str(wav), language=lang if lang in ("hi", "en") else None, beam_size=5,
                               condition_on_previous_text=False, without_timestamps=True)
        return " ".join(s.text.strip() for s in segs).strip()
    except Exception as e:
        print("[asr] local failed:", e, flush=True)
    return None

def split_text(text, max_len=220):
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"(?<=[.!?\u0964\u0965])\s+|\n+", text)
    chunks, cur = [], ""
    for p in parts:
        p = p.strip()
        if not p: continue
        while len(p) > max_len:  # very long sentence: split on comma/space
            cut = max(p.rfind(",", 0, max_len), p.rfind(" ", 0, max_len))
            cut = cut if cut > 40 else max_len
            head, p = p[:cut + 1].strip(), p[cut + 1:].strip()
            if cur: chunks.append(cur); cur = ""
            chunks.append(head)
        if cur and len(cur) + 1 + len(p) > max_len:
            chunks.append(cur); cur = p
        else:
            cur = (cur + " " + p).strip()
    if cur: chunks.append(cur)
    return chunks

# ---------------- jobs ----------------
JOBS_MEM = {}
QUEUE = deque()
Q_COND = threading.Condition()
SEC_PER_CHAR = {"fast": 0.11, "normal": 0.21}   # updated from measurements

def job_path(jid): return JOBS / f"{jid}.json"
def save_job(j):
    tmp = job_path(j["id"]).with_suffix(".tmp"); tmp.write_text(json.dumps(j, ensure_ascii=False)); tmp.replace(job_path(j["id"]))

def public_job(j):
    out = {k: j.get(k) for k in ("id", "status", "voice_id", "voice_name", "text", "lang", "speed", "fast", "created",
                                  "started", "finished", "duration", "gen_seconds", "error", "chunks", "chunks_done")}
    if j["status"] == "queued":
        ids = [x for x in QUEUE]
        out["position"] = ids.index(j["id"]) + 1 if j["id"] in ids else None
    p = 0.0
    if j["status"] == "done": p = 1.0
    elif j["status"] == "running" and j.get("chunks"):
        est = j.get("cur_est") or 10; el = time.time() - (j.get("cur_started") or time.time())
        p = (j.get("chunks_done", 0) + min(el / est, 0.95)) / j["chunks"]
    out["progress"] = round(p, 3)
    if j["status"] == "done":
        out["audio_url"] = sign(f"/jobs/{j['id']}/audio")
    return out

def worker_loop():
    while True:
        with Q_COND:
            while not QUEUE: Q_COND.wait()
            jid = QUEUE[0]
        j = JOBS_MEM.get(jid)
        try:
            if j and j["status"] == "queued": run_job(j)
        except Exception as e:
            j.update(status="error", error=str(e)[:300], finished=time.time()); save_job(j)
            print("[job] failed", jid, repr(e), flush=True)
        finally:
            with Q_COND:
                if QUEUE and QUEUE[0] == jid: QUEUE.popleft()

def run_job(j):
    import numpy as np, soundfile as sf, torch
    from omnivoice import VoiceClonePrompt
    while STATE["loading"]: time.sleep(0.5)
    if STATE["model"] is None: raise RuntimeError("model not loaded")
    m = STATE["model"]
    vdir = VOICES / j["voice_id"]
    if not (vdir / "prompt.pt").exists(): raise RuntimeError("voice not found")
    prompt = VoiceClonePrompt.load(str(vdir / "prompt.pt"))
    chunks = split_text(j["text"]); mode = "fast" if j["fast"] else "normal"
    j.update(status="running", started=time.time(), chunks=len(chunks), chunks_done=0); save_job(j)
    sr = m.sampling_rate; pieces = []; gap = np.zeros(int(sr * 0.28), dtype=np.float32)
    t_all = time.time()
    for i, c in enumerate(chunks):
        j["cur_started"] = time.time(); j["cur_est"] = max(3, len(c) * SEC_PER_CHAR[mode])
        kw = dict(text=c, language=None if j["lang"] == "auto" else j["lang"], voice_clone_prompt=prompt,
                  num_step=16 if j["fast"] else 32)
        if j.get("speed") and abs(j["speed"] - 1) > 0.01: kw["speed"] = j["speed"]
        t1 = time.time()
        with GPU_LOCK, torch.inference_mode():
            a = m.generate(**kw)[0]
        dt = time.time() - t1
        SEC_PER_CHAR[mode] = 0.7 * SEC_PER_CHAR[mode] + 0.3 * (dt / max(len(c), 1))
        pieces.append(np.asarray(a, dtype=np.float32));
        if i < len(chunks) - 1: pieces.append(gap)
        j["chunks_done"] = i + 1; save_job(j)
    audio = np.concatenate(pieces)
    wav = JOBS / f"{j['id']}.wav"; mp3 = JOBS / f"{j['id']}.mp3"
    sf.write(str(wav), audio, sr)
    ffmpeg("-i", str(wav), "-codec:a", "libmp3lame", "-b:a", "160k", "-id3v2_version", "3",
           "-metadata", "title=Dhvani AI", "-metadata", f"artist={j.get('voice_name') or 'Dhvani AI'}", str(mp3))
    wav.unlink(missing_ok=True)
    j.update(status="done", finished=time.time(), duration=round(len(audio) / sr, 2),
             gen_seconds=round(time.time() - t_all, 1)); j.pop("cur_started", None); save_job(j)
    print(f"[job] {j['id']} {len(chunks)} chunk(s) {j['gen_seconds']}s for {j['duration']}s audio ({mode})", flush=True)

def load_jobs():
    files = sorted(JOBS.glob("*.json"), key=lambda p: p.stat().st_mtime)
    for p in files[:-300]:  # keep the last 300 jobs
        p.unlink(missing_ok=True); p.with_suffix(".mp3").unlink(missing_ok=True)
    for p in files[-300:]:
        try:
            j = json.loads(p.read_text())
        except Exception:
            continue
        if j["status"] in ("queued", "running"):
            j.update(status="error", error="server restarted, please generate again"); save_job(j)
        JOBS_MEM[j["id"]] = j

# ---------------- app ----------------
app = FastAPI(title="Dhvani AI", version=VERSION, docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], max_age=3600)

@app.on_event("startup")
def _start():
    load_jobs()
    threading.Thread(target=load_model, daemon=True).start()
    threading.Thread(target=worker_loop, daemon=True).start()

@app.get("/health")
def health():
    return {"ok": True, "app": "dhvani", "version": VERSION, "model_ready": STATE["model"] is not None,
            "model_loading": STATE["loading"], "model_error": STATE["error"], "device": STATE["device"],
            "queue": len(QUEUE), "time": int(time.time())}

class LoginIn(BaseModel):
    password: str
    device: str = "device"

@app.post("/login")
def login(body: LoginIn, request: Request):
    ip = request.headers.get("x-dhvani-client-ip") or request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")
    rate("login:" + ip, 10, 600)
    if not hmac.compare_digest(body.password.strip(), SECRETS["app_password"]):
        raise HTTPException(403, "wrong password")
    tok = secrets.token_urlsafe(24)
    with _dev_lock:
        d = _devices(); d[_h(tok)] = {"device": body.device[:60], "created": int(time.time())}; _save_devices(d)
    return {"token": tok}

@app.get("/me")
def me(authorization: str = Header(None)):
    auth(authorization); return {"ok": True}

def voice_meta(vid):
    p = VOICES / vid / "meta.json"
    return json.loads(p.read_text()) if p.exists() else None

@app.get("/voices")
def list_voices(authorization: str = Header(None)):
    auth(authorization)
    vs = [m for m in (voice_meta(p.name) for p in VOICES.iterdir() if p.is_dir()) if m]
    vs.sort(key=lambda m: m["created"], reverse=True)
    for v in vs: v["sample_url"] = sign(f"/voices/{v['id']}/sample")
    return {"voices": vs}

@app.post("/voices")
def create_voice(authorization: str = Header(None), file: UploadFile = File(...), name: str = Form("Meri awaaz"),
                 lang: str = Form("hi"), ref_text: str = Form(""), consent: str = Form("")):
    tk = auth(authorization)
    if consent not in ("1", "true", "yes", "on"):
        raise HTTPException(400, "consent required")
    if len([p for p in VOICES.iterdir() if p.is_dir()]) >= MAX_VOICES:
        raise HTTPException(400, f"max {MAX_VOICES} voices; delete one first")
    rate("voice:" + tk, 20)
    vid = uuid.uuid4().hex[:12]; vdir = VOICES / vid; tmp = Path(tempfile.mkdtemp())
    try:
        raw = tmp / "upload.bin"; size = 0
        with open(raw, "wb") as fh:
            while True:
                b = file.file.read(1 << 20)
                if not b: break
                size += len(b)
                if size > MAX_UPLOAD: raise HTTPException(413, f"file too big (max {MAX_UPLOAD // 1048576} MB)")
                fh.write(b)
        full = tmp / "full.wav"   # decode first: browser recordings (webm/opus) carry no duration header
        try:
            ffmpeg("-i", str(raw), "-t", "301", "-ac", "1", "-ar", "24000", str(full))
        except subprocess.CalledProcessError:
            raise HTTPException(400, "could not read this audio file")
        dur_in = probe_duration(full)
        if dur_in < 3: raise HTTPException(400, "recording too short (min 3 seconds)")
        if dur_in > 300: raise HTTPException(400, "recording too long (max 5 minutes)")
        vdir.mkdir(parents=True)
        wav = vdir / "ref.wav"
        try:
            to_ref_wav(full, wav)
        except subprocess.CalledProcessError:
            raise HTTPException(400, "could not read this audio file")
        dur = probe_duration(wav)
        if dur < 2.5: raise HTTPException(400, "too little speech found; record again in a quiet place")
        t0 = time.time()
        text = transcribe(wav, lang) or ref_text.strip() or None
        asr_s = round(time.time() - t0, 1)
        while STATE["loading"]: time.sleep(0.5)
        if STATE["model"] is None: raise HTTPException(503, "model not loaded")
        with GPU_LOCK:
            prompt = STATE["model"].create_voice_clone_prompt(ref_audio=str(wav), ref_text=text)
        prompt.save(str(vdir / "prompt.pt"))
        ffmpeg("-i", str(wav), "-codec:a", "libmp3lame", "-b:a", "96k", str(vdir / "sample.mp3"))
        meta = {"id": vid, "name": (name.strip() or "Meri awaaz")[:40], "lang": lang, "created": int(time.time()),
                "ref_seconds": round(dur, 1), "transcript": text, "asr_seconds": asr_s}
        (vdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
        meta["sample_url"] = sign(f"/voices/{vid}/sample")
        return meta
    except Exception:
        shutil.rmtree(vdir, ignore_errors=True); raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@app.delete("/voices/{vid}")
def delete_voice(vid: str, authorization: str = Header(None)):
    auth(authorization)
    if not re.fullmatch(r"[0-9a-f]{12}", vid) or not (VOICES / vid).is_dir(): raise HTTPException(404, "not found")
    shutil.rmtree(VOICES / vid); return {"deleted": vid}

@app.get("/voices/{vid}/sample")
def voice_sample(vid: str, exp: str = "", sig: str = ""):
    if not check_sig(f"/voices/{vid}/sample", exp, sig): raise HTTPException(403, "link expired")
    p = VOICES / vid / "sample.mp3"
    if not re.fullmatch(r"[0-9a-f]{12}", vid) or not p.exists(): raise HTTPException(404, "not found")
    return FileResponse(p, media_type="audio/mpeg")

class TTSIn(BaseModel):
    voice_id: str
    text: str
    lang: str = "hi"
    speed: float = 1.0
    fast: bool = False

@app.post("/tts")
def tts(body: TTSIn, authorization: str = Header(None)):
    tk = auth(authorization)
    text = body.text.strip()
    if not text: raise HTTPException(400, "text empty")
    if len(text) > MAX_CHARS: raise HTTPException(400, f"text too long (max {MAX_CHARS} characters)")
    if body.lang not in ("hi", "en", "auto"): raise HTTPException(400, "lang must be hi, en or auto")
    m = voice_meta(body.voice_id) if re.fullmatch(r"[0-9a-f]{12}", body.voice_id) else None
    if not m: raise HTTPException(404, "voice not found")
    if len(QUEUE) >= MAX_QUEUE: raise HTTPException(429, "server busy, try in a minute")
    rate("tts:" + tk, JOBS_PER_HOUR)
    jid = uuid.uuid4().hex[:16]
    j = {"id": jid, "status": "queued", "voice_id": body.voice_id, "voice_name": m["name"], "text": text,
         "lang": body.lang, "speed": max(0.6, min(1.5, body.speed)), "fast": bool(body.fast), "created": time.time(),
         "owner": tk[:16]}
    JOBS_MEM[jid] = j; save_job(j)
    with Q_COND:
        QUEUE.append(jid); Q_COND.notify()
    est = sum(max(3, len(c) * SEC_PER_CHAR["fast" if j["fast"] else "normal"]) for c in split_text(text))
    out = public_job(j); out["estimate_seconds"] = round(est); return out

@app.get("/jobs")
def list_jobs(authorization: str = Header(None), limit: int = 50):
    auth(authorization)
    js = sorted(JOBS_MEM.values(), key=lambda j: j["created"], reverse=True)[:max(1, min(limit, 200))]
    return {"jobs": [public_job(j) for j in js]}

@app.get("/jobs/{jid}")
def get_job(jid: str, authorization: str = Header(None)):
    auth(authorization)
    j = JOBS_MEM.get(jid)
    if not j: raise HTTPException(404, "not found")
    return public_job(j)

@app.delete("/jobs/{jid}")
def delete_job(jid: str, authorization: str = Header(None)):
    auth(authorization)
    j = JOBS_MEM.get(jid)
    if not j: raise HTTPException(404, "not found")
    if j["status"] == "running": raise HTTPException(409, "job is running")
    with Q_COND:
        if jid in QUEUE: QUEUE.remove(jid)
    JOBS_MEM.pop(jid, None); job_path(jid).unlink(missing_ok=True); (JOBS / f"{jid}.mp3").unlink(missing_ok=True)
    return {"deleted": jid}

@app.get("/jobs/{jid}/audio")
def job_audio(jid: str, exp: str = "", sig: str = "", download: int = 0):
    if not check_sig(f"/jobs/{jid}/audio", exp, sig): raise HTTPException(403, "link expired")
    p = JOBS / f"{jid}.mp3"
    if not re.fullmatch(r"[0-9a-f]{16}", jid) or not p.exists(): raise HTTPException(404, "not found")
    fn = f"dhvani-{jid[:6]}.mp3"
    return FileResponse(p, media_type="audio/mpeg", filename=fn if download else None,
                        content_disposition_type="attachment" if download else "inline")
