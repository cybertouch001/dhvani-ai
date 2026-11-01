#!/usr/bin/env bash
# Dhvani AI — start/restart the backend + public tunnel and point the site at it. Safe to run any time (idempotent).
#   ./start.sh            start whatever is not running, re-publish the server URL
#   ./start.sh restart    kill server + tunnel and start fresh
#   ./start.sh status     show what is running
#   ./start.sh stop       stop both
set -u
exec 9>/tmp/dhvani-start.lock; flock -w 120 9 || { echo "another start.sh is running"; exit 1; }
D=/home/user/work/dhvani
PY=/home/user/work/omnivoice/venv/bin/python
PORT=8765
SITE=https://dhvani.sites.tab.bot
LOG=$D/logs; mkdir -p "$LOG"
SECRETS=$D/private/secrets.json

server_ok() { curl -s -m 5 "http://127.0.0.1:$PORT/health" | grep -q '"app":"dhvani"'; }
tunnel_pid() { pgrep -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" | head -1; }
tunnel_url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/tunnel.log" 2>/dev/null | tail -1; }
# check a public URL through Cloudflare DNS directly (the box's resolver caches "not found" for new tunnel names)
public_ok() {
  local u=$1 host ip; host=${u#https://}
  ip=$(curl -s -m 8 -H 'accept: application/dns-json' "https://1.1.1.1/dns-query?name=$host&type=A" | sed -n 's/.*"data":"\([0-9.]*\)".*/\1/p' | head -1)
  [ -n "$ip" ] || return 1
  curl -s -m 10 --resolve "$host:443:$ip" "$u/health" | grep -q '"app":"dhvani"'
}

stop_all() {
  pkill -f "uvicorn app:app --host 127.0.0.1 --port $PORT" 2>/dev/null
  pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" 2>/dev/null
  sleep 1
}

case "${1:-start}" in
  stop) stop_all; echo stopped; exit 0;;
  status)
    server_ok && echo "server: up (127.0.0.1:$PORT)" || echo "server: DOWN"
    [ -n "$(tunnel_pid)" ] && echo "tunnel: up $(tunnel_url)" || echo "tunnel: DOWN"
    echo "site config: $(curl -s -m 8 $SITE/config.json)"; exit 0;;
  restart) stop_all;;
esac

# 1) backend
if ! server_ok; then
  pkill -f "uvicorn app:app --host 127.0.0.1 --port $PORT" 2>/dev/null; sleep 1
  cd "$D/server"
  setsid nohup "$PY" -m uvicorn app:app --host 127.0.0.1 --port $PORT --workers 1 >> "$LOG/server.log" 2>&1 < /dev/null 9>&- &
  for i in $(seq 1 60); do server_ok && break; sleep 1; done
fi
server_ok || { echo "ERROR: server did not start — see $LOG/server.log"; exit 1; }
echo "server: up"

# 2) tunnel (reuse the running one if its URL still answers)
URL=""
if [ -n "$(tunnel_pid)" ]; then
  URL=$(tunnel_url)
  if [ -z "$URL" ] || ! public_ok "$URL"; then pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT"; sleep 1; URL=""; fi
fi
if [ -z "$URL" ]; then
  : > "$LOG/tunnel.log"
  setsid nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$LOG/tunnel.log" 2>&1 < /dev/null 9>&- &
  for i in $(seq 1 40); do URL=$(tunnel_url); [ -n "$URL" ] && break; sleep 1; done
  [ -n "$URL" ] || { echo "ERROR: tunnel gave no URL — see $LOG/tunnel.log"; exit 1; }
  for i in $(seq 1 45); do public_ok "$URL" && break; sleep 3; done
fi
public_ok "$URL" || { echo "ERROR: tunnel $URL not answering"; exit 1; }
echo "tunnel: $URL"

# 3) point the site at it (only when it changed)
CUR=$(curl -s -m 10 "$SITE/config.json" | sed -n 's/.*"server":"\([^"]*\)".*/\1/p')
if [ "$CUR" != "$URL" ]; then
  TOK=$("$PY" -c "import json;print(json.load(open('$SECRETS'))['site_admin_token'])")
  R=$(curl -s -m 15 -X POST "$SITE/admin/server" -H "x-admin-token: $TOK" -H 'content-type: application/json' -d "{\"url\":\"$URL\"}")
  echo "$R" | grep -q '"ok":true' || { echo "ERROR: could not update site config: $R"; exit 1; }
  echo "site: now points to $URL"
else
  echo "site: already points to $URL"
fi
# 4) final check through the site
curl -s -m 20 "$SITE/api/health" | grep -q '"app":"dhvani"' && echo "OK: $SITE is live" || echo "WARN: $SITE/api/health not answering yet"
