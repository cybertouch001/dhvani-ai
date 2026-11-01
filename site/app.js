/* Dhvani AI web app. Talks to the backend through the site's /api proxy (the site forwards to the current server). */
(() => {
const API = '/api';
const $ = (s) => document.querySelector(s);
const LS = window.localStorage;
const native = window.DhvaniNative || null;   // present inside the Android app
let token = LS.getItem('dhvani_token') || '';
let voices = [];
let online = false;

const SAMPLES = {
  hi: 'नमस्ते, मैं अपनी आवाज़ रिकॉर्ड कर रहा हूँ। आज मौसम बहुत अच्छा है, और मैं आराम से, साफ़-साफ़ बोल रहा हूँ ताकि मेरी आवाज़ सही बने।',
  en: 'Hello, I am recording my voice today. The weather is pleasant, and I am speaking slowly and clearly so that my voice sounds natural.'
};
let sampleLang = 'hi';

function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
function show(id) { for (const s of ['offline', 'login', 'app']) $('#' + s).hidden = s !== id; }
function setStatus(on, text) { const s = $('#status'); s.className = 'status ' + (on ? 'on' : 'off'); $('#statusText').textContent = text; }
function fmtTime(ts) { const d = new Date(ts * 1000); return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

class Offline extends Error {}
async function api(path, opts = {}, timeoutMs = 25000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = Object.assign({}, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.json) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  let r;
  try { r = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body, signal: ctl.signal, cache: 'no-store' }); }
  catch (e) { goOffline(); throw new Offline('offline'); }
  finally { clearTimeout(tm); }
  if (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 530) {
    let j = {}; try { j = await r.clone().json(); } catch (e) {}
    if (j.offline || r.status !== 503 || !j.detail) { goOffline(); throw new Offline('offline'); }
  }
  let data = null; try { data = await r.json(); } catch (e) {}
  if (r.status === 401) { token = ''; LS.removeItem('dhvani_token'); show('login'); throw new Error('Login dobara karo'); }
  if (!r.ok) throw new Error((data && (data.detail || data.error)) || ('Error ' + r.status));
  return data;
}

function goOffline() { online = false; setStatus(false, 'Offline'); show('offline'); }

async function checkHealth() {
  try {
    const h = await api('/health', {}, 15000);
    online = true;
    setStatus(true, h.model_ready ? 'Online' : 'Starting…');
    return h;
  } catch (e) { return null; }
}

async function boot() {
  setStatus(false, 'Checking…');
  const h = await checkHealth();
  if (!h) return;
  if (!token) { show('login'); return; }
  try { await api('/me'); } catch (e) { if (!(e instanceof Offline)) show('login'); return; }
  show('app');
  await loadVoices();
  resumeJob();
}

/* ---------- login ---------- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try {
    const dev = native ? 'android' : (/Android/i.test(navigator.userAgent) ? 'android-web' : 'web');
    const r = await api('/login', { method: 'POST', json: { password: $('#pw').value, device: dev } });
    token = r.token; LS.setItem('dhvani_token', token); $('#pw').value = '';
    show('app'); await loadVoices();
  } catch (err) { if (!(err instanceof Offline)) $('#loginErr').textContent = err.message === 'wrong password' ? 'Galat password' : err.message; }
});
$('#logout').addEventListener('click', () => { token = ''; LS.removeItem('dhvani_token'); show('login'); });
$('#retryBtn').addEventListener('click', boot);

/* ---------- tabs ---------- */
function goTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.hidden = s.id !== 'tab-' + name);
  if (name === 'history') loadHistory();
  if (name === 'voices') renderVoices();
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => goTab(b.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => goTab(b.dataset.goto)));

/* ---------- voices ---------- */
async function loadVoices() {
  try { voices = (await api('/voices')).voices; } catch (e) { return; }
  const sel = $('#voiceSel'); const prev = sel.value || LS.getItem('dhvani_voice');
  sel.innerHTML = voices.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  if (voices.some(v => v.id === prev)) sel.value = prev;
  $('#noVoice').hidden = voices.length > 0; $('#genBtn').disabled = voices.length === 0;
  renderVoices();
}
function renderVoices() {
  const ul = $('#voiceList');
  if (!voices.length) { ul.innerHTML = '<li class="empty">Abhi koi awaaz save nahi hai.</li>'; return; }
  ul.innerHTML = voices.map(v => `<li><div class="t"><div><b>${esc(v.name)}</b><div class="meta">${fmtTime(v.created)} · ${v.ref_seconds}s · ${v.lang === 'en' ? 'English' : 'Hindi'}</div></div>
    <button class="btn small" data-del="${v.id}" aria-label="Delete ${esc(v.name)}">🗑️</button></div>
    ${v.transcript ? `<div class="txt">“${esc(v.transcript)}”</div>` : ''}
    <audio controls preload="none" src="${API}${v.sample_url}"></audio>
    <div class="acts"><button class="btn" data-use="${v.id}">Is awaaz se bolo ▶</button></div></li>`).join('');
  ul.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Ye awaaz delete karein?')) return;
    try { await api('/voices/' + b.dataset.del, { method: 'DELETE' }); toast('Delete ho gaya'); loadVoices(); } catch (e) { toast(e.message); }
  });
  ul.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { $('#voiceSel').value = b.dataset.use; LS.setItem('dhvani_voice', b.dataset.use); goTab('speak'); });
}
$('#voiceSel').addEventListener('change', e => LS.setItem('dhvani_voice', e.target.value));

/* sample text */
function setSample(l) { sampleLang = l; $('#sampleText').textContent = SAMPLES[l]; document.querySelectorAll('[data-s]').forEach(c => c.classList.toggle('on', c.dataset.s === l)); }
document.querySelectorAll('[data-s]').forEach(c => c.addEventListener('click', () => setSample(c.dataset.s)));
setSample('hi');

/* recorder */
let refBlob = null, refName = 'recording.webm', refFromRecorder = false;
let rec = null, recStream = null, recChunks = [], recT0 = 0, recTimer = null, audioCtx = null, raf = 0;
function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
async function startRec() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Is browser mein recording nahi chalti — audio file choose karo.'); return; }
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { toast('Mic permission nahi mili. Settings mein mic allow karo ya file choose karo.'); return; }
  const mime = pickMime();
  rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recChunks = []; rec.ondataavailable = e => e.data.size && recChunks.push(e.data);
  rec.onstop = () => {
    const type = rec.mimeType || mime || 'audio/webm';
    const blob = new Blob(recChunks, { type });
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('aac') ? 'aac' : 'webm';
    setRef(blob, 'recording.' + ext, true);
    recStream.getTracks().forEach(t => t.stop()); cancelAnimationFrame(raf); if (audioCtx) audioCtx.close();
  };
  rec.start(250); recT0 = Date.now(); $('#recBtn').classList.add('on'); $('#recHint').textContent = 'Recording… dobara dabao to rukega';
  recTimer = setInterval(() => { const s = (Date.now() - recT0) / 1000; $('#recTime').textContent = '0:' + String(Math.floor(s)).padStart(2, '0'); if (s >= 20) stopRec(); }, 200);
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)(); const an = audioCtx.createAnalyser(); an.fftSize = 512;
    audioCtx.createMediaStreamSource(recStream).connect(an); const buf = new Uint8Array(an.fftSize); const cv = $('#meter'), cx = cv.getContext('2d');
    const draw = () => { an.getByteTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v - 128)); cx.clearRect(0, 0, cv.width, cv.height);
      const w = Math.min(1, pk / 90) * cv.width; const g = cx.createLinearGradient(0, 0, cv.width, 0); g.addColorStop(0, '#FF8A3D'); g.addColorStop(1, '#8B5CFF');
      cx.fillStyle = '#2a2560'; cx.fillRect(0, 14, cv.width, 8); cx.fillStyle = g; cx.fillRect(0, 14, w, 8); raf = requestAnimationFrame(draw); };
    draw();
  } catch (e) {}
}
function stopRec() {
  clearInterval(recTimer); $('#recBtn').classList.remove('on'); $('#recHint').textContent = 'Ho gaya. Sun ke check karo, phir save karo.';
  const s = (Date.now() - recT0) / 1000; if (rec && rec.state !== 'inactive') rec.stop();
  if (s < 5) toast('Thoda lamba bolo — kam se kam 8-10 second.');
}
$('#recBtn').addEventListener('click', () => (rec && rec.state === 'recording') ? stopRec() : startRec());
$('#fileIn').addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; if (f.size > 10 * 1024 * 1024) { toast('File 10 MB se badi hai'); return; } setRef(f, f.name, false); });
function setRef(blob, name, fromRec) {
  refBlob = blob; refName = name; refFromRecorder = fromRec;
  const a = $('#refAudio'); a.src = URL.createObjectURL(blob); $('#refPreview').hidden = false;
  a.onloadedmetadata = () => { const d = a.duration; $('#refInfo').textContent = (isFinite(d) ? d.toFixed(1) + ' sec · ' : '') + (fromRec ? 'recording' : name); };
  updateSave();
}
function updateSave() { $('#saveVoice').disabled = !(refBlob && $('#consent').checked); }
$('#consent').addEventListener('change', updateSave);
$('#saveVoice').addEventListener('click', async () => {
  $('#voiceErr').textContent = ''; const btn = $('#saveVoice'); btn.disabled = true; btn.textContent = 'Save ho raha hai… (~10-20 sec)';
  try {
    const fd = new FormData(); fd.append('file', refBlob, refName); fd.append('name', $('#vname').value || 'Meri awaaz');
    fd.append('lang', sampleLang); fd.append('ref_text', refFromRecorder ? SAMPLES[sampleLang] : ''); fd.append('consent', '1');
    const v = await api('/voices', { method: 'POST', body: fd }, 120000);
    toast('Awaaz save ho gayi ✅'); refBlob = null; $('#refPreview').hidden = true; $('#vname').value = ''; $('#consent').checked = false; $('#recTime').textContent = '0:00';
    LS.setItem('dhvani_voice', v.id); await loadVoices(); $('#voiceSel').value = v.id; goTab('speak');
  } catch (e) { if (!(e instanceof Offline)) $('#voiceErr').textContent = e.message; }
  finally { btn.textContent = 'Awaaz save karo'; updateSave(); }
});

/* ---------- speak ---------- */
const textEl = $('#text');
textEl.value = LS.getItem('dhvani_text') || '';
const updCount = () => { $('#count').textContent = textEl.value.length + ' / 1500'; LS.setItem('dhvani_text', textEl.value); };
textEl.addEventListener('input', updCount); updCount();
$('#lang').value = LS.getItem('dhvani_lang') || 'hi'; $('#lang').addEventListener('change', e => LS.setItem('dhvani_lang', e.target.value));
$('#speed').addEventListener('input', e => $('#speedVal').textContent = Number(e.target.value).toFixed(2).replace(/0$/, '') + '×');
$('#fast').checked = LS.getItem('dhvani_fast') === '1'; $('#fast').addEventListener('change', e => LS.setItem('dhvani_fast', e.target.checked ? '1' : '0'));

let polling = null;
$('#genBtn').addEventListener('click', async () => {
  const text = textEl.value.trim(); if (!text) { toast('Pehle text likho'); textEl.focus(); return; }
  const voice_id = $('#voiceSel').value; if (!voice_id) { goTab('voices'); return; }
  $('#genBtn').disabled = true; $('#result').hidden = true;
  try {
    const j = await api('/tts', { method: 'POST', json: { voice_id, text, lang: $('#lang').value, speed: Number($('#speed').value), fast: $('#fast').checked } });
    LS.setItem('dhvani_job', j.id); trackJob(j);
  } catch (e) { if (!(e instanceof Offline)) toast(e.message); $('#genBtn').disabled = false; }
});
function trackJob(j) {
  const t0 = Date.now(); $('#job').hidden = false; renderJob(j);
  clearInterval(polling);
  polling = setInterval(async () => {
    try { j = await api('/jobs/' + j.id, {}, 15000); } catch (e) { if (e instanceof Offline) clearInterval(polling); return; }
    renderJob(j, t0);
    if (j.status === 'done' || j.status === 'error') { clearInterval(polling); $('#genBtn').disabled = false; LS.removeItem('dhvani_job'); }
  }, 1500);
}
function renderJob(j) {
  const pct = Math.round((j.progress || 0) * 100);
  $('#jobBar').style.width = (j.status === 'queued' ? 3 : Math.max(5, pct)) + '%';
  $('#jobPct').textContent = j.status === 'running' ? pct + '%' : '';
  if (j.status === 'queued') $('#jobText').textContent = j.position > 1 ? `Line mein #${j.position}…` : 'Shuru ho raha hai…';
  else if (j.status === 'running') $('#jobText').textContent = `Ban raha hai… ${j.chunks > 1 ? `(${j.chunks_done}/${j.chunks} hisse)` : ''}`;
  else if (j.status === 'error') { $('#jobText').textContent = '❌ ' + (j.error || 'Error'); }
  else if (j.status === 'done') { $('#job').hidden = true; showResult(j); }
}
function showResult(j) {
  const src = API + j.audio_url;
  $('#player').src = src; $('#dlBtn').href = src + '&download=1'; $('#dlBtn').setAttribute('download', `dhvani-${j.id.slice(0, 6)}.mp3`);
  $('#resultInfo').textContent = `${j.duration}s awaaz · ${j.gen_seconds}s mein bani · ${j.voice_name}`;
  $('#result').hidden = false; $('#result').dataset.url = src; $('#result').dataset.name = `dhvani-${j.id.slice(0, 6)}.mp3`;
  $('#player').play().catch(() => {});
}
async function resumeJob() { const id = LS.getItem('dhvani_job'); if (!id) return; try { const j = await api('/jobs/' + id); if (j.status === 'queued' || j.status === 'running') { $('#genBtn').disabled = true; trackJob(j); } else LS.removeItem('dhvani_job'); } catch (e) { LS.removeItem('dhvani_job'); } }

async function shareAudio(url, name) {
  const abs = new URL(url, location.href).href;
  if (native && native.share) { native.share(abs + (abs.includes('?') ? '&' : '?') + 'download=1', name); return; }
  try {
    const blob = await (await fetch(abs)).blob(); const file = new File([blob], name, { type: 'audio/mpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Dhvani AI' }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  if (navigator.share) { try { await navigator.share({ title: 'Dhvani AI', url: abs }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(abs); toast('Link copy ho gaya (24 ghante chalega)'); } catch (e) { toast('Share nahi hua — Download use karo'); }
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[download]'); if (!a || a.dataset.blob) return;
  e.preventDefault();
  const href = new URL(a.getAttribute('href'), location.href).href, name = a.getAttribute('download') || 'dhvani.mp3';
  if (native && native.download) { native.download(href, name); return; }
  try {   // fetch as a blob, then save: works the same in every browser
    const r = await fetch(href); if (!r.ok) throw new Error('HTTP ' + r.status);
    const url = URL.createObjectURL(await r.blob());
    const t = document.createElement('a'); t.href = url; t.download = name; t.dataset.blob = '1'; document.body.appendChild(t); t.click(); t.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); toast('Download ho gaya ✅');
  } catch (err) { toast('Download nahi hua — dobara try karo'); }
});
$('#shareBtn').addEventListener('click', () => shareAudio($('#result').dataset.url, $('#result').dataset.name));

/* ---------- history ---------- */
async function loadHistory() {
  const ul = $('#histList'); ul.innerHTML = '<li class="empty">Loading…</li>';
  let jobs = []; try { jobs = (await api('/jobs?limit=60')).jobs; } catch (e) { ul.innerHTML = ''; return; }
  if (!jobs.length) { ul.innerHTML = '<li class="empty">Abhi kuch nahi banaya.</li>'; return; }
  ul.innerHTML = jobs.map(j => `<li><div class="t"><div><b>${esc(j.voice_name || '')}</b><div class="meta">${fmtTime(j.created)} · ${j.lang} ${j.fast ? '· ⚡' : ''} ${j.status === 'done' ? '· ' + j.duration + 's' : '· ' + j.status}</div></div>
     <button class="btn small" data-hdel="${j.id}" aria-label="Delete">🗑️</button></div>
     <div class="txt">${esc(j.text)}</div>
     ${j.status === 'done' ? `<audio controls preload="none" src="${API}${j.audio_url}"></audio>
     <div class="acts"><a class="btn" href="${API}${j.audio_url}&download=1" download="dhvani-${j.id.slice(0, 6)}.mp3">⬇️ MP3</a><button class="btn" data-hshare="${API}${j.audio_url}" data-name="dhvani-${j.id.slice(0, 6)}.mp3">📤 Share</button><button class="btn" data-again="${j.id}">↻ Text dobara use karo</button></div>`
      : j.status === 'error' ? `<div class="err">${esc(j.error || '')}</div>` : ''}</li>`).join('');
  ul.querySelectorAll('[data-hdel]').forEach(b => b.onclick = async () => { try { await api('/jobs/' + b.dataset.hdel, { method: 'DELETE' }); loadHistory(); } catch (e) { toast(e.message); } });
  ul.querySelectorAll('[data-hshare]').forEach(b => b.onclick = () => shareAudio(b.dataset.hshare, b.dataset.name));
  ul.querySelectorAll('[data-again]').forEach(b => b.onclick = () => { const j = jobs.find(x => x.id === b.dataset.again); textEl.value = j.text; updCount(); $('#lang').value = j.lang; if (voices.some(v => v.id === j.voice_id)) $('#voiceSel').value = j.voice_id; goTab('speak'); });
}
$('#refreshHist').addEventListener('click', loadHistory);

setInterval(async () => { if (document.hidden) return; const was = online; const h = await checkHealth(); if (h && !was) boot(); }, 30000);
window.dhvaniRetry = boot;
boot();
})();
