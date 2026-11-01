// Dhvani AI site Worker: static app + /api proxy to the current backend + config + APK download.
// The backend URL lives in D1 (DB, table cfg, key "server"); start.sh updates it via POST /admin/server.
// To move the backend (Hugging Face Space, GPU server, own VPS): POST the new URL — the apps do not change.
const ADMIN_TOKEN_SHA256 = 'SET_ME_sha256_hex_of_your_admin_token';

async function sha256hex(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

async function ensure(env) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run(); }
async function getServer(env) { try { const r = await env.DB.prepare('SELECT v FROM cfg WHERE k = ?').bind('server').first(); return r ? JSON.parse(r.v) : null; } catch (e) { return null; } }

async function proxy(req, env, url) {
  const cfg = await getServer(env);
  if (!cfg || !cfg.url) return json({ offline: true, error: 'server not configured' }, 503);
  const target = cfg.url.replace(/\/$/, '') + url.pathname.slice(4) + url.search;
  const h = new Headers(req.headers);
  for (const k of ['host', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cookie']) h.delete(k);
  h.set('x-dhvani-client-ip', req.headers.get('cf-connecting-ip') || '');
  const ctl = new AbortController(); const isUpload = req.method === 'POST' && url.pathname.startsWith('/api/voices');
  const t = setTimeout(() => ctl.abort(), isUpload ? 120000 : 30000);
  try {
    const fh = new Headers(h); fh.delete('range');
    const r = await fetch(target, { method: req.method, headers: fh, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body, redirect: 'manual', signal: ctl.signal });
    if ([502, 503, 504, 521, 522, 523, 524, 530].includes(r.status)) {
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return json({ offline: true, error: 'server unreachable', upstream_status: r.status }, 503);
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.startsWith('audio/') && req.method === 'GET') {   // audio: send as one complete body (download managers + players)
      const buf = await r.arrayBuffer();
      const h2 = new Headers({ 'content-type': ct, 'content-length': String(buf.byteLength), 'cache-control': 'private, max-age=3600' });
      const cd = r.headers.get('content-disposition'); if (cd) h2.set('content-disposition', cd);
      return new Response(buf, { status: r.status === 206 ? 200 : r.status, headers: h2 });
    }
    const out = new Response(r.body, r); out.headers.set('cache-control', 'no-store'); out.headers.delete('access-control-allow-origin');
    return out;
  } catch (e) {
    return json({ offline: true, error: 'server unreachable' }, 503);
  } finally { clearTimeout(t); }
}

async function serveChunked(env, req, manifest, filename) {
  const man = await env.ASSETS.fetch(new Request(new URL('/_dl/' + manifest, req.url)));
  if (!man.ok) return new Response('Not found', { status: 404 });
  const info = await man.json();
  const { readable, writable } = new FixedLengthStream(info.size);
  (async () => { const w = writable.getWriter(); try { for (const c of info.chunks) { const r = await env.ASSETS.fetch(new Request(new URL('/_dl/' + c, req.url))); await w.write(new Uint8Array(await r.arrayBuffer())); } await w.close(); } catch (e) { await w.abort(e); } })();
  return new Response(readable, { headers: { 'content-type': 'application/vnd.android.package-archive', 'content-length': String(info.size), 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-cache', 'x-sha256': info.sha256 || '' } });
}

function sec(r) {
  const h = new Headers(r.headers);
  h.set('x-content-type-options', 'nosniff'); h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('permissions-policy', 'microphone=(self), camera=()');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return proxy(req, env, url);
    if (url.pathname === '/config.json') {
      const cfg = await getServer(env);
      return json({ app: 'Dhvani AI', api: url.origin + '/api', server: cfg ? cfg.url : null, updated: cfg ? cfg.updated : null, android: url.origin + '/download/dhvani-ai.apk' }, 200, { 'access-control-allow-origin': '*' });
    }
    if (url.pathname === '/admin/server' && req.method === 'POST') {
      const tok = req.headers.get('x-admin-token') || '';
      if (!tok || (await sha256hex(tok)) !== ADMIN_TOKEN_SHA256) return json({ error: 'forbidden' }, 403);
      let body = {}; try { body = await req.json(); } catch (e) {}
      if (!body.url || !/^https:\/\/[^\s]+$/.test(body.url)) return json({ error: 'url must be https' }, 400);
      const v = { url: body.url.replace(/\/$/, ''), updated: new Date().toISOString() };
      await ensure(env); await env.DB.prepare('INSERT INTO cfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('server', JSON.stringify(v)).run();
      return json({ ok: true, ...v });
    }
    if (url.pathname === '/download/dhvani-ai.apk') return serveChunked(env, req, 'apk.json', 'dhvani-ai.apk');
    if (url.pathname === '/download/info.json') { const r = await env.ASSETS.fetch(new Request(new URL('/_dl/apk.json', req.url))); return json(r.ok ? await r.json() : {}, r.ok ? 200 : 404); }
    if (url.pathname.startsWith('/_dl/')) return new Response('Not found', { status: 404 });
    if (url.pathname === '/download' || url.pathname === '/download/') return sec(await env.ASSETS.fetch(new Request(new URL('/download.html', req.url), req)));
    return sec(await env.ASSETS.fetch(req));
  }
};
