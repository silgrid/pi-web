#!/usr/bin/env bash
# deploy-piweb.sh — update and restart the @silgrid/pi-web service in this container.
#
# This container has no systemd; pi-web runs inside a detached tmux session
# ("piweb" by default) with a restart loop. PI_WEB_IDLE_TIMEOUT_MS=0 disables
# the 10-minute idle auto-exit so the server does not appear to "self-exit"
# while running unattended as a service.
#
# The server binds 0.0.0.0 (override with PIWEB_HOST) so it is reachable from
# outside the container, and PI_WEB_PASSWORD set in the calling environment is
# passed through so the deployed service keeps its existing auth behavior.
#
# Exposure modes (opt-in via PIWEB_EXPOSE; leaving it unset keeps the legacy
# self-managed deployment — same bind, same allowed-hosts passthrough, no
# tunnel/serve tooling installed or torn down. One pi#107 behavior change:
# a redeploy recycles the pi-web loop window(s) instead of killing the
# session, so an unnamed loop window left by an older deploy or the README
# autostart recipe is replaced too):
#   PIWEB_EXPOSE=lan         direct cleartext http://<host-LAN-IP>:<port> on the
#                            same network; no extra tooling
#   PIWEB_EXPOSE=tailscale   Tailscale + `tailscale serve`, mounting pi-web at
#                            https://<machine>.<tailnet>.ts.net with an
#                            auto-provisioned Let's Encrypt cert (recommended)
#   PIWEB_EXPOSE=cloudflare  cloudflared outbound-only tunnel;
#                            PIWEB_TUNNEL=quick|named (default: quick)
#
# In tailscale/cloudflare modes the served/tunnel hostname is appended to
# PI_WEB_ALLOWED_HOSTS before pi-web starts (request-security rejects unknown
# Host headers otherwise); operator entries are preserved and come first. The
# serve/tunnel process runs as a tmux window of the same session, so killing
# the session stops it. Re-running the script is tunnel-idempotent (pi#107):
# a deploy recycles only the pi-web loop window(s) and keeps a serve/tunnel
# window that is alive and forwarding to the current port — its process, and
# for a quick tunnel its trycloudflare.com URL, survive the redeploy. A stale
# (wrong port) or dead serve/tunnel is replaced (its window included).
#
# Two invocation modes:
#   1. From the repository root:            ./deploy-piweb.sh
#   2. After a global npm install:          pi-web-deploy
#      (the bin/pi/pi-web-deploy shim runs this same script from inside the
#       installed package directory; arguments and env are passed through)
#
# Usage: ./deploy-piweb.sh   (or: pi-web-deploy after `npm i -g @silgrid/pi-web`)
# Env:
#   PIWEB_TMUX_SESSION  tmux session name (default: piweb)
#   PIWEB_PORT          optional port override passed to pi-web
#   PIWEB_HOST          bind address (default: 0.0.0.0)
#   PI_WEB_PASSWORD     optional web-auth password passed through to pi-web
#   PIWEB_EXPOSE        optional exposure mode: lan | tailscale | cloudflare
#   PIWEB_TUNNEL        cloudflare mode only: quick | named (default: quick)
#   PIWEB_CF_CONFIG     cloudflare named mode: path to the operator-supplied
#                       cloudflared config.yml (tunnel ID, credentials-file,
#                       and ingress <hostname> -> http://127.0.0.1:<port>)
#   PIWEB_CF_HOSTNAME   cloudflare named mode: the public ingress hostname to
#                       append to PI_WEB_ALLOWED_HOSTS
set -euo pipefail

SESSION="${PIWEB_TMUX_SESSION:-piweb}"
PKG="@silgrid/pi-web"
HOST="${PIWEB_HOST:-0.0.0.0}"

# ---------------------------------------------------------------------------
# Exposure-mode selection.
# Validated BEFORE any uninstall/install/tmux side effect so a bad value fails
# fast with nothing changed on the machine.
# ---------------------------------------------------------------------------
EXPOSE="${PIWEB_EXPOSE:-}"
case "${EXPOSE}" in
  "" | lan | tailscale | cloudflare) ;;
  *)
    echo "ERROR: unsupported PIWEB_EXPOSE='${EXPOSE}'." >&2
    echo "       Valid values: PIWEB_EXPOSE=lan | tailscale | cloudflare," >&2
    echo "       or leave it unset for the legacy self-managed deployment." >&2
    exit 1
    ;;
esac

TUNNEL="${PIWEB_TUNNEL:-quick}"
if [ -n "${PIWEB_TUNNEL:-}" ] && [ "${EXPOSE}" != "cloudflare" ]; then
  echo "==> Note: PIWEB_TUNNEL is only consumed by PIWEB_EXPOSE=cloudflare; ignoring it here."
fi
if [ "${EXPOSE}" = "cloudflare" ]; then
  case "${TUNNEL}" in
    quick | named) ;;
    *)
      echo "ERROR: unsupported PIWEB_TUNNEL='${TUNNEL}'." >&2
      echo "       Valid values: PIWEB_TUNNEL=quick | named." >&2
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Allowed-hosts wiring. EFFECTIVE_ALLOWED_HOSTS is what the restart loop
# expands into pi-web's environment: the operator's PI_WEB_ALLOWED_HOSTS value
# unchanged when unset/lan, plus the served/tunnel hostname appended in
# tailscale/cloudflare modes. Operator entries are preserved and come first.
# ---------------------------------------------------------------------------
EFFECTIVE_ALLOWED_HOSTS="${PI_WEB_ALLOWED_HOSTS:-}"

append_allowed_host() {
  local host="$1"
  [ -z "${host}" ] && return 0
  case ",${EFFECTIVE_ALLOWED_HOSTS}," in
    *",${host},"*) return 0 ;; # already present
  esac
  if [ -n "${EFFECTIVE_ALLOWED_HOSTS}" ]; then
    EFFECTIVE_ALLOWED_HOSTS="${EFFECTIVE_ALLOWED_HOSTS},${host}"
  else
    EFFECTIVE_ALLOWED_HOSTS="${host}"
  fi
}

# Port wiring: an unset PIWEB_PORT keeps the legacy behavior (no --port flag;
# pi-web uses its own default). Exposed modes need a predictable local port
# for the serve/tunnel backends, so they default to 8142 and pass it
# explicitly so pi-web binds exactly where serve/tunnel proxy to.
PORT_ARGS="${PIWEB_PORT:+--port ${PIWEB_PORT}}"
if [ -n "${EXPOSE}" ] && [ -z "${PIWEB_PORT:-}" ]; then
  PIWEB_PORT=8142
  PORT_ARGS="--port ${PIWEB_PORT}"
fi
LOCAL_PORT="${PIWEB_PORT:-30141}"

# ---------------------------------------------------------------------------
# Tooling helpers for the exposure modes (best-effort install when absent).
# ---------------------------------------------------------------------------
install_tailscale() {
  command -v tailscale >/dev/null 2>&1 && return 0
  echo "==> Installing Tailscale"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install tailscale
      else
        echo "ERROR: Homebrew not found; install Tailscale from https://tailscale.com/download first." >&2
        return 1
      fi
      ;;
    Linux)
      curl -fsSL https://tailscale.com/install.sh | sh
      ;;
    *)
      echo "ERROR: unsupported platform for Tailscale: $(uname -s)" >&2
      return 1
      ;;
  esac
}

install_cloudflared() {
  command -v cloudflared >/dev/null 2>&1 && return 0
  echo "==> Installing cloudflared"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install cloudflared
      else
        echo "ERROR: Homebrew not found; install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ first." >&2
        return 1
      fi
      ;;
    Linux)
      case "$(uname -m)" in
        x86_64) CF_ARCH=amd64 ;;
        aarch64 | arm64) CF_ARCH=arm64 ;;
        *)
          echo "ERROR: unsupported architecture for cloudflared: $(uname -m)" >&2
          return 1
          ;;
      esac
      curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
      && chmod +x /usr/local/bin/cloudflared
      ;;
    *)
      echo "ERROR: unsupported platform for cloudflared: $(uname -s)" >&2
      return 1
      ;;
  esac
}

# Extract Self.DNSName (minus any trailing dot) from tailscale JSON output
# read on stdin. Node is used (never jq) because this script already requires
# npm/node for the pi-web install itself.
ts_self_dnsname() {
  node -e 'let s="";process.stdin.on("data",d=>{s+=d});process.stdin.on("end",()=>{try{const j=JSON.parse(s);const n=(j.Self&&j.Self.DNSName)||"";process.stdout.write(n.replace(/\.+$/,""));}catch(e){}});'
}

ts_resolve_hostname() {
  local host=""
  host="$(tailscale dns status --json 2>/dev/null | ts_self_dnsname || true)"
  if [ -z "${host}" ]; then
    host="$(tailscale status --json 2>/dev/null | ts_self_dnsname || true)"
  fi
  printf '%s' "${host}"
}

# ---------------------------------------------------------------------------
# Mode preparation. Each branch installs/verifies its tooling, resolves the
# hostname that must be allowed, and appends it to EFFECTIVE_ALLOWED_HOSTS.
# Runs BEFORE the uninstall/install/tmux steps; nothing here touches pi-web
# itself. LAN mode mutates nothing (the caveats are stated, not mitigated).
# ---------------------------------------------------------------------------
prepare_mode() {
  case "${EXPOSE}" in
    "" ) ;; # legacy self-managed path: no exposure-related work
    lan)
      local lan_ip=""
      case "$(uname -s)" in
        Linux)
          lan_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}' || true)"
          ;;
        Darwin)
          lan_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
          ;;
      esac
      echo "==> PIWEB_EXPOSE=lan: pi-web binds ${HOST}:${LOCAL_PORT}; open"
      echo "    http://${lan_ip:-<host-LAN-IP>}:${LOCAL_PORT} from a device on the same network."
      echo "    Cleartext caveat: PWA install degrades over HTTP (browsers may not offer"
      echo "    'Install app'). Chrome app-mode windows (the piweb launcher) open http://"
      echo "    origins fine."
      ;;
    tailscale)
      install_tailscale
      # tailscaled must be reachable for `tailscale up` to talk to it.
      if ! tailscale status >/dev/null 2>&1; then
        if command -v tailscaled >/dev/null 2>&1; then
          echo "==> tailscaled not reachable; starting it in the background"
          nohup tailscaled >/tmp/tailscaled.log 2>&1 &
          sleep 2
        fi
      fi
      # Actually request login: without this, a clean machine never joins the
      # tailnet, ts_resolve_hostname returns empty, and the script exits 1
      # (review blocker, pi#38).
      tailscale status >/dev/null 2>&1 || tailscale up
      echo "==> Running 'tailscale up' (this blocks until SSO login completes)."
      echo "    Sign in with GitHub or Apple — both work in mainland China; Google SSO does not."
      TS_HOST="$(ts_resolve_hostname)"
      if [ -z "${TS_HOST}" ]; then
        echo "ERROR: could not resolve the tailnet hostname (Self.DNSName)." >&2
        echo "       Is this machine logged in to the tailnet? See 'tailscale status'." >&2
        exit 1
      fi
      append_allowed_host "${TS_HOST}"
      echo "==> Tailscale mode: pi-web will be served at https://${TS_HOST}"
      echo "    (hostname appended to PI_WEB_ALLOWED_HOSTS)"
      ;;
    cloudflare)
      install_cloudflared
      if [ "${TUNNEL}" = "named" ]; then
        if [ -z "${PIWEB_CF_CONFIG:-}" ] || [ -z "${PIWEB_CF_HOSTNAME:-}" ]; then
          echo "ERROR: PIWEB_TUNNEL=named requires a Cloudflare account with your domain on" >&2
          echo "       Cloudflare DNS, plus operator-supplied:" >&2
          echo "  PIWEB_CF_CONFIG    path to your cloudflared config.yml (tunnel ID," >&2
          echo "                     credentials-file, ingress <hostname> -> http://127.0.0.1:${LOCAL_PORT})" >&2
          echo "  PIWEB_CF_HOSTNAME  the public ingress hostname to append to PI_WEB_ALLOWED_HOSTS" >&2
          exit 1
        fi
        if [ ! -f "${PIWEB_CF_CONFIG}" ]; then
          echo "ERROR: PIWEB_CF_CONFIG '${PIWEB_CF_CONFIG}' does not exist." >&2
          exit 1
        fi
        append_allowed_host "${PIWEB_CF_HOSTNAME}"
        echo "==> Cloudflare named tunnel: hostname '${PIWEB_CF_HOSTNAME}' appended to PI_WEB_ALLOWED_HOSTS"
      else
        # Quick tunnel: the URL is only known once cloudflared runs — captured
        # after the tunnel window starts, or recovered from the stable log on
        # a redeploy whose tunnel is still healthy. Nothing to prepare here;
        # the deploy step decides reuse vs. replace.
        :
      fi
      ;;
  esac
}

prepare_mode

# The upstream @agegr/pi-web package owns the same global bin name (pi-web);
# uninstall it first so installing ours does not fail with EEXIST. Harmless
# when it is already gone.
if npm ls -g @agegr/pi-web >/dev/null 2>&1; then
  echo "==> Removing superseded @agegr/pi-web global install (same pi-web bin)"
  npm uninstall -g @agegr/pi-web
fi

echo "==> Installing ${PKG}@latest"
npm install -g "${PKG}@latest"

# pi#107: a deploy is tunnel-idempotent — the tmux session is no longer torn
# down. Only the pi-web restart-loop window(s) are recycled; a healthy
# serve/tunnel window (and its quick URL) survives the redeploy. (The old
# script killed the whole session and rebuilt the tunnel on every run, so
# every deploy minted a fresh trycloudflare.com URL.)

# The restart-loop command is (re)built at the point of use so it always
# embeds the final EFFECTIVE_ALLOWED_HOSTS (a quick-tunnel hostname is only
# known after cloudflared starts).
build_loop_cmd() {
  # shellcheck disable=SC2016  # the single quotes are deliberate: the tmux
  # command string must expand the variables inside the loop's shell, not here
  # Unset provider env credentials that leak from the container shell
  # (pi#109): OPENAI_API_KEY would activate pi's builtin `openai` provider
  # and dump its full 44-model backlog (gpt-4/gpt-4o/o1/o3/...) into the
  # model selector, even though this deployment only uses the models.json
  # sub2api providers.
  LOOP_CMD="
  while true; do
    PI_WEB_IDLE_TIMEOUT_MS=0 ${PI_WEB_PASSWORD:+PI_WEB_PASSWORD='${PI_WEB_PASSWORD}'} ${EFFECTIVE_ALLOWED_HOSTS:+PI_WEB_ALLOWED_HOSTS='${EFFECTIVE_ALLOWED_HOSTS}'} env -u OPENAI_API_KEY -u OPENAI_BASE_URL pi-web -H ${HOST} ${PORT_ARGS}
    echo '[piweb] pi-web exited; restarting in 5s' >&2
    sleep 5
  done
"
}

# ---------------------------------------------------------------------------
# tmux recycling (pi#107: deploys are tunnel-idempotent). A deploy recycles
# only the pi-web restart-loop window(s); the session and any serve/tunnel
# window are kept. Killing a session's last window destroys the session, so
# session existence is re-checked after every kill — never cached from
# before a kill.
# ---------------------------------------------------------------------------
session_exists() {
  tmux has-session -t "${SESSION}" 2>/dev/null
}

# Recycle the pi-web restart-loop window (kill + recreate). Every window that
# is not a serve/tunnel window is an old loop window — named 'piweb' by this
# script, or unnamed (pre-pi#107 deploys and the README autostart recipe
# create it that way) — and is replaced, so a legacy session converges to
# exactly one named 'piweb' loop window on the first post-fix deploy. If the
# recycled windows were the session's last, the session dies with them and is
# created fresh — either way exactly one pi-web loop window runs afterwards.
recycle_piweb_window() {
  if session_exists; then
    echo "==> Recycling pi-web window(s) in tmux session '${SESSION}'"
    local wins win_id win_name
    wins="$(tmux list-windows -t "${SESSION}" -F '#{window_id}|#{window_name}' 2>/dev/null || true)"
    while IFS='|' read -r win_id win_name; do
      [ -z "${win_id}" ] && continue
      case "${win_name}" in tunnel | serve) continue ;; esac
      tmux kill-window -t "${win_id}" 2>/dev/null || true
      session_exists || break
    done <<EOF
${wins}
EOF
  fi
  if session_exists; then
    # Target "${SESSION}:" (trailing colon): a bare session name makes tmux
    # 3.4 create the window at the session's CURRENT window index and fail
    # with 'index 1 in use' (pi#109, hit live on 2026-10-18).
    tmux new-window -t "${SESSION}:" -n piweb "${LOOP_CMD}"
  else
    echo "==> Creating tmux session '${SESSION}' (window 'piweb')"
    tmux new-session -d -s "${SESSION}" -n piweb "${LOOP_CMD}"
  fi
}

# Replace a named serve/tunnel window (kill + recreate; same last-window
# caveat as above: re-check the session after killing the old window, then
# create the replacement in whatever shape survives).
replace_window() {
  local name="$1" cmd="$2"
  if session_exists; then
    tmux kill-window -t "${SESSION}:${name}" 2>/dev/null || true
  fi
  if session_exists; then
    # Same "${SESSION}:" target discipline as recycle_piweb_window (pi#109).
    tmux new-window -t "${SESSION}:" -n "${name}" "${cmd}"
  else
    tmux new-session -d -s "${SESSION}" -n "${name}" "${cmd}"
  fi
}

# Quick-tunnel connector log at a stable path (was: a fresh mktemp file per
# run, which made the previous URL unrecoverable). A redeploy with a healthy
# connector recovers the URL from this file.
QUICK_TUNNEL_LOG="${HOME}/.piweb/${SESSION}-quick-tunnel.log"

quick_tunnel_url_from_log() {
  grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "${QUICK_TUNNEL_LOG}" 2>/dev/null \
    | head -n 1 | sed 's|^https://||' || true
}

# Is a cloudflared process matching <ERE> alive? A pgrep -f match counts
# only when the matched process itself IS cloudflared (comm check): the
# tmux server forked by this script's tunnel-window creation keeps the
# client's argv for its whole life (tmux renames only its comm, to
# 'tmux: server'), so a bare pgrep -f keeps matching the server after the
# connector died and a redeploy would "reuse" a dead tunnel — stale URL,
# no connector, no tunnel window (pi#118). A PID that dies between pgrep
# and ps fails the comm read and counts as dead. The comm is compared by
# basename, not exactly: Linux ps prints the bare executable name, but BSD
# ps (macOS, a supported install target) prints the invoked executable's
# full path there (e.g. /opt/homebrew/bin/cloudflared) — an exact compare
# would judge every healthy connector dead on macOS and replace it on each
# redeploy, breaking the healthy-tunnel reuse guarantee (pi#107).
cloudflared_alive() {
  local pattern="$1" pid comm
  for pid in $(pgrep -f "${pattern}" 2>/dev/null); do
    comm="$(ps -p "${pid}" -o comm= 2>/dev/null || true)"
    if [ "${comm##*/}" = "cloudflared" ]; then
      return 0
    fi
  done
  return 1
}

# Is a quick-tunnel connector for THIS local port already alive? Identity:
# a live cloudflared process whose command line targets
# http://127.0.0.1:${LOCAL_PORT} (the [^0-9] anchor keeps :8142 from matching
# :81421). A connector started by any means is found via its command line. A
# connector forwarding to a different port (PIWEB_PORT changed) misses and
# is replaced.
quick_tunnel_alive() {
  cloudflared_alive "cloudflared tunnel --url http://127\.0\.0\.1:${LOCAL_PORT}([^0-9]|$)"
}

# Named tunnel: identity is a live cloudflared connector for this exact
# config, plus the config's ingress service port must equal the port pi-web
# binds now (a PIWEB_PORT change means the running tunnel forwards to a
# stale port).
named_tunnel_alive() {
  cloudflared_alive "cloudflared tunnel --config ${PIWEB_CF_CONFIG}" || return 1
  local cfg_port
  cfg_port="$(grep -oE 'http://(127\.0\.0\.1|localhost):[0-9]+' "${PIWEB_CF_CONFIG}" 2>/dev/null | head -n 1 | grep -oE '[0-9]+$' || true)"
  [ "${cfg_port}" = "${LOCAL_PORT}" ]
}

# Does 'tailscale serve' already map the served origin to this local port?
# (serve config persists in tailscaled, so a healthy mapping survives
# redeploys and must be kept, not reset.)
tailscale_serve_current() {
  tailscale serve status 2>/dev/null | grep -qE "(127\.0\.0\.1|localhost):${LOCAL_PORT}([^0-9]|$)"
}

case "${EXPOSE}" in
  "" | lan | tailscale)
    # Legacy / LAN path: identical to the original script except that a
    # redeploy recycles the pi-web loop window(s) — including unnamed ones
    # left by pre-pi#107 deploys and the README autostart recipe — instead of
    # killing the whole session (LAN prepared nothing but an informational
    # echo above).
    build_loop_cmd
    recycle_piweb_window
    if [ "${EXPOSE}" = "tailscale" ]; then
      if tailscale_serve_current; then
        echo "==> 'tailscale serve' already forwards to 127.0.0.1:${LOCAL_PORT}; keeping it"
      else
        # No serve mapping for this port (fresh, stale, or dead): reset any
        # stale serve config so this deploy never inherits one, then
        # re-assert it with a foreground holder window — killing a previous
        # 'serve' window first (`serve --reset` clears the config but does
        # not stop a foreground holder, so it must be replaced, not kept).
        tailscale serve --reset >/dev/null 2>&1 || true
        echo "==> Starting 'tailscale serve' (foreground; dies with this session)"
        replace_window serve "tailscale serve --https=443 http://127.0.0.1:${LOCAL_PORT}"
      fi
      echo "==> pi-web served at https://${TS_HOST} (proxying 127.0.0.1:${LOCAL_PORT})"
    fi
    ;;
  cloudflare)
    if [ "${TUNNEL}" = "quick" ]; then
      # The trycloudflare.com URL only exists once cloudflared runs. A healthy
      # connector for this port is reused as-is and its URL recovered from
      # the stable log; only when the tunnel is missing, stale (different
      # port), or its URL is unrecoverable is the tunnel window replaced and
      # a fresh URL captured — in which case the rebuilt pi-web allow-list
      # carries the new URL.
      mkdir -p "${HOME}/.piweb"
      CF_HOST=""
      if quick_tunnel_alive; then
        echo "==> Reusing healthy cloudflared quick tunnel (tmux window 'tunnel')"
        CF_HOST="$(quick_tunnel_url_from_log)"
        if [ -z "${CF_HOST}" ]; then
          echo "==> Tunnel alive but its URL is not recoverable from ${QUICK_TUNNEL_LOG}; restarting it"
        fi
      fi
      if [ -z "${CF_HOST}" ]; then
        : >"${QUICK_TUNNEL_LOG}"
        echo "==> Starting cloudflared quick tunnel (tmux window 'tunnel')"
        replace_window tunnel \
          "cloudflared tunnel --url http://127.0.0.1:${LOCAL_PORT} >'${QUICK_TUNNEL_LOG}' 2>&1"
        echo "==> Waiting for the trycloudflare.com URL (full log: ${QUICK_TUNNEL_LOG})"
        i=0
        while [ "${i}" -lt 30 ]; do
          CF_HOST="$(quick_tunnel_url_from_log)"
          [ -n "${CF_HOST}" ] && break
          i=$((i + 1))
          sleep 1
        done
        if [ -z "${CF_HOST}" ]; then
          echo "ERROR: could not capture the trycloudflare.com URL. cloudflared output:" >&2
          cat "${QUICK_TUNNEL_LOG}" >&2 2>/dev/null || true
          tmux kill-session -t "${SESSION}" 2>/dev/null || true
          exit 1
        fi
      fi
      append_allowed_host "${CF_HOST}"
      build_loop_cmd
      echo "==> Quick tunnel up: https://${CF_HOST} (hostname appended to PI_WEB_ALLOWED_HOSTS)"
      echo "    WARNING: quick-tunnel URLs are DEMO-ONLY. Reusing a healthy tunnel keeps the"
      echo "    URL stable across redeploys, but the connector restarting (or dying) still"
      echo "    mints a new one; never bake a trycloudflare.com URL into a PWA or app-mode"
      echo "    client."
      echo "    Use PIWEB_TUNNEL=named (or PIWEB_EXPOSE=tailscale) for a stable origin."
      recycle_piweb_window
    else
      if named_tunnel_alive; then
        echo "==> Reusing cloudflared named tunnel (config: ${PIWEB_CF_CONFIG})"
      else
        echo "==> Starting cloudflared named tunnel (config: ${PIWEB_CF_CONFIG})"
        replace_window tunnel "cloudflared tunnel --config ${PIWEB_CF_CONFIG}"
      fi
      build_loop_cmd
      recycle_piweb_window
    fi
    ;;
esac

echo "==> pi-web running in tmux session '${SESSION}'"
tmux ls
