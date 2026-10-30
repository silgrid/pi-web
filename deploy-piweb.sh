#!/usr/bin/env bash
# deploy-piweb.sh — update and restart the @silgrid/pi-web service in this container.
#
# This container has no systemd; pi-web runs inside a detached tmux session
# ("piweb" by default) with a restart loop. PI_WEB_IDLE_TIMEOUT_MS=0 disables
# the 10-minute idle auto-exit so the server does not appear to "self-exit"
# while running unattended as a service.
#
# The service shape (port, password, allowed hosts, install channel) comes
# from the caller's environment. The lane runs from the daemon environment,
# which by design carries no PIWEB_*/PI_WEB_* values, so any shape variable the
# caller does not set is read from the operator's
# ~/.config/piweb/deploy.env (0600). Explicit caller values always win.
#
# Dependencies: bash, tmux, npm and curl (curl runs the post-swap service
# probe and the TLS edge probe; without it the service probe fails naming
# curl and the edge probe is skipped with one line naming curl).
#
# The deploy fails closed: a bind address that is not loopback is refused
# before any install or tmux side effect unless both PIWEB_PORT and
# PI_WEB_PASSWORD are set, so an incomplete shape can never fall back to
# pi-web's default port or start without web auth. After the swap, a complete
# shape (port + password) is probed on the configured port: GET /login must
# answer 200 and an anonymous /api request must answer 401, within a bounded
# wait. A failed probe exits 3 so .polyforge/deploy.sh can report the
# post-swap failure truthfully instead of claiming not_changed.
# Then the deploy checks that the served pi-web is the installed one: the
# package `command -v pi-web` resolves to, its version against the version
# npm just installed under its global root, and the package of the script the
# running 'piweb' loop process executes must all agree (up to 3 attempts in a
# 30s deadline, after the loop's first process is up). Any disagreement, or a
# point that cannot be read ("unknown"), prints exactly one
# "warn: serving <old>, installed <new>" line and never changes the exit code.
# Then the TLS edge of the first PI_WEB_ALLOWED_HOSTS entry is probed once
# (https GET /, 5s timeout; any HTTP answer counts). The edge is an
# independent service, so a failure only prints
# "warn: TLS edge unreachable (<host>)" and never changes the exit code; an
# empty list skips the edge probe with one line.
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
#   PIWEB_PORT          port passed to pi-web (required for a non-loopback
#                       bind; deploy.env may supply it)
#   PIWEB_HOST          bind address (default: 0.0.0.0; non-loopback binds
#                       require PIWEB_PORT and PI_WEB_PASSWORD)
#   PI_WEB_PASSWORD     web-auth password passed through to pi-web (required
#                       for a non-loopback bind; deploy.env may supply it)
#   PIWEB_EXPOSE        optional exposure mode: lan | tailscale | cloudflare
#   PIWEB_TUNNEL        cloudflare mode only: quick | named (default: quick)
#   PIWEB_CF_CONFIG     cloudflare named mode: path to the operator-supplied
#                       cloudflared config.yml (tunnel ID, credentials-file,
#                       and ingress <hostname> -> http://127.0.0.1:<port>)
#   PIWEB_CF_HOSTNAME   cloudflare named mode: the public ingress hostname to
#                       append to PI_WEB_ALLOWED_HOSTS
#   PIWEB_INSTALL_REPO   optional internal install channel: OWNER/REPO whose
#                        GitHub Release provides the pi-web tarball; the
#                        tgz + its SHA256SUMS asset are downloaded to a
#                        scratch dir, checksum-verified, and installed
#                        globally in place of the public-npm @latest
#                        install (a mismatch aborts before anything is
#                        installed). Unset keeps the public-npm path.
#   PIWEB_INSTALL_VERSION  optional release pin for the channel above: the
#                        vX.Y.Z tag of exactly the release to install. When
#                        set, that release is resolved, checked to equal
#                        the requested tag, and only its tarball installed
#                        — latest is never resolved. Unset keeps the
#                        latest-release-wins channel (no version filtering).
#
# ~/.config/piweb/deploy.env (0600) may supply the shape keys above
# (PIWEB_PORT, PIWEB_HOST, PI_WEB_PASSWORD, PI_WEB_ALLOWED_HOSTS,
# PIWEB_INSTALL_REPO, PIWEB_INSTALL_VERSION). It is parsed as KEY=VALUE, never
# sourced, and only those keys are read. An unquoted value ends at a ` #`
# (whitespace, then `#`): the rest of the line is a comment; a quoted value
# keeps its content, `#` included. A file that is not mode 0600 or not owned
# by the deploying user is used anyway, with one `warn:` line. Values are
# never printed; only the names of the keys actually loaded are logged.
set -euo pipefail

# ---------------------------------------------------------------------------
# Service-shape loader: fill only variables the caller left unset. An
# explicitly set variable (even an empty one) wins over the file. Parsing
# KEY=VALUE avoids executing operator content, and the allowlist keeps the
# file from smuggling unrelated environment into the deployed service.
# ---------------------------------------------------------------------------
load_deploy_env() {
  local file="${HOME}/.config/piweb/deploy.env"
  [ -f "${file}" ] || return 0
  if [ ! -r "${file}" ]; then
    echo "==> Note: ${file} is not readable; using the caller environment only." >&2
    return 0
  fi

  local line key value stripped loaded=""
  local quoted_double='^"(.*)"[[:space:]]*(#.*)?$' quoted_single="^'(.*)'[[:space:]]*(#.*)?\$"
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "${line}" in
      "" | "#"*) continue ;;
    esac
    line="${line#export }"
    case "${line}" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      PIWEB_PORT | PIWEB_HOST | PI_WEB_PASSWORD | PI_WEB_ALLOWED_HOSTS | \
        PIWEB_INSTALL_REPO | PIWEB_INSTALL_VERSION) ;;
      *) continue ;;
    esac
    # Explicit caller environment wins, including an explicitly empty value.
    if [ -n "${!key+x}" ]; then
      continue
    fi
    # A quoted value keeps its content (a trailing comment after the closing
    # quote is dropped); an unquoted value ends at whitespace followed by `#`.
    if [[ "${value}" =~ ${quoted_double} ]] || [[ "${value}" =~ ${quoted_single} ]]; then
      value="${BASH_REMATCH[1]}"
    else
      stripped="${value%%[[:space:]]#*}"
      if [ "${stripped}" != "${value}" ]; then
        value="${stripped%"${stripped##*[![:space:]]}"}"
      fi
    fi
    printf -v "${key}" '%s' "${value}"
    loaded="${loaded}${loaded:+ }${key}"
  done < "${file}"

  if [ -n "${loaded}" ]; then
    echo "==> Loaded service shape from ${file} (${loaded})"
  fi

  # The file holds the web-auth password: warn (never fail) when its mode is
  # not 0600 or it is not the deploying user's. Names the file, mode and
  # owner only, never a value.
  local mode owner
  case "$(uname -s)" in
    Darwin | *BSD) mode="$(stat -f %Lp "${file}" 2>/dev/null || true)"; owner="$(stat -f %u "${file}" 2>/dev/null || true)" ;;
    *) mode="$(stat -c %a "${file}" 2>/dev/null || true)"; owner="$(stat -c %u "${file}" 2>/dev/null || true)" ;;
  esac
  if [ -n "${mode}" ] && { [ "${mode}" != "600" ] || [ "${owner}" != "$(id -u)" ]; }; then
    echo "warn: ${file} has mode ${mode} and owner uid ${owner}; expected mode 0600 owned by uid $(id -u) (it holds the service password)."
  fi
}

load_deploy_env

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

# Port wiring: an unset PIWEB_PORT keeps the legacy behavior only on a
# loopback bind (no --port flag; pi-web uses its own default); a non-loopback
# bind without PIWEB_PORT is refused by the fail-closed guard below. Exposed
# modes need a predictable local port for the serve/tunnel backends, so they
# default to 8142 and pass it explicitly so pi-web binds exactly where
# serve/tunnel proxy to.
PORT_ARGS="${PIWEB_PORT:+--port ${PIWEB_PORT}}"
if [ -n "${EXPOSE}" ] && [ -z "${PIWEB_PORT:-}" ]; then
  PIWEB_PORT=8142
  PORT_ARGS="--port ${PIWEB_PORT}"
fi
LOCAL_PORT="${PIWEB_PORT:-30141}"

# ---------------------------------------------------------------------------
# Fail closed: a non-loopback bind without both a configured port and a
# password would silently fall back to pi-web's default port and disable web
# auth. Refuse before prepare_mode or any install/tmux side effect, and name
# exactly what is missing.
# ---------------------------------------------------------------------------
is_loopback_host() {
  case "$1" in
    127.* | localhost | ::1 | "[::1]") return 0 ;;
  esac
  return 1
}

if ! is_loopback_host "${HOST}"; then
  missing=""
  [ -n "${PIWEB_PORT:-}" ] || missing="${missing} PIWEB_PORT"
  [ -n "${PI_WEB_PASSWORD:-}" ] || missing="${missing} PI_WEB_PASSWORD"
  if [ -n "${missing}" ]; then
    echo "ERROR: refusing to deploy pi-web on non-loopback '${HOST}' without the complete service shape." >&2
    echo "       Missing:${missing}." >&2
    echo "       Set these in the caller environment or in ~/.config/piweb/deploy.env." >&2
    exit 1
  fi
fi

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

# Scratch dir for the PIWEB_INSTALL_REPO channel download; empty (and the
# trap a no-op) on the default public-npm path.
CHANNEL_DIR=""
cleanup_channel_dir() {
  [ -n "${CHANNEL_DIR}" ] && rm -rf "${CHANNEL_DIR}"
}

# PIWEB_INSTALL_REPO opts into the internal GitHub-Releases install channel
# (strict opt-in: with it unset the public-npm path below is byte-identical
# to the original). PIWEB_INSTALL_VERSION pins the install to exactly that
# release tag (resolved, checked to equal the requested pin, then downloaded
# and installed — latest is never resolved on the pinned path); without the
# pin the repo's LATEST release wins as-is — no version filtering — so the
# channel tracks whatever release GitHub reports.
if [ -n "${PIWEB_INSTALL_REPO:-}" ]; then
  CHANNEL_DIR="$(mktemp -d)"
  trap cleanup_channel_dir EXIT
  if [ -n "${PIWEB_INSTALL_VERSION:-}" ]; then
    echo "==> Installing ${PKG} from GitHub Release ${PIWEB_INSTALL_VERSION} of ${PIWEB_INSTALL_REPO}"
    CHANNEL_TAG="$(gh release view -R "${PIWEB_INSTALL_REPO}" "${PIWEB_INSTALL_VERSION}" --json tagName --jq .tagName)"
    if [ "${CHANNEL_TAG}" != "${PIWEB_INSTALL_VERSION}" ]; then
      echo "ERROR: ${PIWEB_INSTALL_VERSION} of ${PIWEB_INSTALL_REPO} resolved to tag '${CHANNEL_TAG}', not the requested release." >&2
      exit 1
    fi
    gh release download -R "${PIWEB_INSTALL_REPO}" "${PIWEB_INSTALL_VERSION}" -p '*.tgz' -p SHA256SUMS -D "${CHANNEL_DIR}"
  else
    echo "==> Installing ${PKG} from the latest GitHub Release of ${PIWEB_INSTALL_REPO}"
    CHANNEL_TAG="$(gh release view -R "${PIWEB_INSTALL_REPO}" --json tagName --jq .tagName)"
    gh release download -R "${PIWEB_INSTALL_REPO}" -p '*.tgz' -p SHA256SUMS -D "${CHANNEL_DIR}"
  fi
  # Assets are downloaded flattened into CHANNEL_DIR, so the checksum file's
  # bare filename matches there. Any mismatch aborts (set -e) BEFORE any
  # global install side effect.
  (cd "${CHANNEL_DIR}" && sha256sum -c SHA256SUMS)
  CHANNEL_TGZ="$(find "${CHANNEL_DIR}" -maxdepth 1 -name '*.tgz' -print -quit)"
  if [ -z "${CHANNEL_TGZ}" ]; then
    echo "ERROR: the latest release of ${PIWEB_INSTALL_REPO} carries no *.tgz asset." >&2
    exit 1
  fi
  echo "==> Checksum verified; installing ${CHANNEL_TGZ##*/} (release ${CHANNEL_TAG:-latest})"
  npm install -g "${CHANNEL_TGZ}"
else
  echo "==> Installing ${PKG}@latest"
  npm install -g "${PKG}@latest"
fi

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
  # model selector, even though this deployment only uses the custom
  # models.json providers.
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

# ---------------------------------------------------------------------------
# Service probe. A complete shape (configured port + password) has an endpoint
# the deploy can actually verify; probe it after the swap, before the deploy
# may claim success. The loop window starts asynchronously, so wait on the real
# condition with a deadline instead of assuming the bind is immediate.
# ---------------------------------------------------------------------------
probe_configured_service() {
  local host="$1" port="$2"
  local deadline=$((SECONDS + 20)) login="" anon=""
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    login="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://${host}:${port}/login" 2>/dev/null || true)"
    anon="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://${host}:${port}/api/sessions" 2>/dev/null || true)"
    if [ "${login}" = "200" ] && [ "${anon}" = "401" ]; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: pi-web on ${host}:${port} did not answer GET /login with 200 and the anonymous API with 401 within 20s (last: /login ${login:-unreachable}, /api/sessions ${anon:-unreachable})." >&2
  return 1
}

# The probe runs only when BOTH the port and the password are set: only then
# is there a known endpoint whose anonymous API must answer 401. A loopback
# deploy with a port but no password (allowed: it is not exposed) therefore
# gets no reachability check at all; an operator who wants one sets
# PI_WEB_PASSWORD too, or checks http://127.0.0.1:<port>/ by hand.
if [ -n "${PIWEB_PORT:-}" ] && [ -n "${PI_WEB_PASSWORD:-}" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: the service probe needs curl, and curl is not installed; pi-web on port ${LOCAL_PORT} was swapped but not verified." >&2
    exit 3
  fi
  PROBE_HOST="${HOST}"
  case "${PROBE_HOST}" in
    0.0.0.0 | :: | "[::]") PROBE_HOST="127.0.0.1" ;;
  esac
  if ! probe_configured_service "${PROBE_HOST}" "${LOCAL_PORT}"; then
    echo "==> pi-web was installed and its tmux window was swapped, but the configured service is not healthy." >&2
    exit 3
  fi
  echo "==> Service probe OK: http://${PROBE_HOST}:${LOCAL_PORT}/login 200, anonymous /api/sessions 401"
fi

# ---------------------------------------------------------------------------
# Served == installed self-check (warn-only). npm may install into a prefix
# whose bin dir is not on the service PATH, leaving the loop serving an older
# pi-web while the deploy reports success. Three points must agree: the
# package `command -v pi-web` resolves to, its version against the version
# npm just installed, and the package of the script the running loop process
# executes. Paths and versions only are printed, never a deploy.env value.
# ---------------------------------------------------------------------------

# Print "<version>|<package dir>" of the PKG package that owns <path> (symlinks
# resolved, nearest package.json upwards, which must be PKG), or nothing.
piweb_package_of() {
  # shellcheck disable=SC2016  # the single-quoted program is JavaScript
  node -e '
const fs = require("fs");
const path = require("path");
let dir;
try { dir = path.dirname(fs.realpathSync(process.argv[1])); } catch { process.exit(0); }
for (;;) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch {}
  if (pkg) {
    if (pkg.name === process.argv[2] && pkg.version) process.stdout.write(`${pkg.version}|${dir}`);
    process.exit(0);
  }
  const up = path.dirname(dir);
  if (up === dir) process.exit(0);
  dir = up;
}' "$1" "${PKG}" 2>/dev/null || true
}

# The version the install just wrote under npm's global root; falls back to
# `npm ls -g`, then "unknown".
installed_piweb_version() {
  local root version=""
  root="$(npm root -g 2>/dev/null || true)"
  if [ -n "${root}" ]; then
    version="$(piweb_package_of "${root}/${PKG}/package.json")"
    version="${version%%|*}"
  fi
  if [ -z "${version}" ]; then
    version="$(npm ls -g "${PKG}" --depth=0 2>/dev/null | grep -oE "${PKG}@[0-9][^ ]*" | head -n 1 | sed "s|^${PKG}@||" || true)"
  fi
  printf '%s' "${version:-unknown}"
}

# Inspect the processes of the session's 'piweb' window (each pane and its
# direct children). Prints "path <script>" for the first absolute pi-web
# script token, "unidentified" when the loop runs a process without one, and
# nothing while the loop has not started a process yet.
running_piweb_script() {
  local panes win pane_pid pid args tok seen=""
  local -a toks
  panes="$(tmux list-panes -s -t "${SESSION}" -F '#{window_name} #{pane_pid}' 2>/dev/null || true)"
  while read -r win pane_pid; do
    if [ "${win}" != "piweb" ] || [ -z "${pane_pid}" ]; then continue; fi
    for pid in "${pane_pid}" $(pgrep -P "${pane_pid}" 2>/dev/null || true); do
      args="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
      [ -n "${args}" ] || continue
      [ "${pid}" = "${pane_pid}" ] || seen=1
      read -r -a toks <<<"${args}"
      for tok in "${toks[@]}"; do
        case "${tok}" in
          /*/pi-web | /*/pi-web.js) printf 'path %s' "${tok}"; return 0 ;;
        esac
      done
    done
  done <<EOF
${panes}
EOF
  [ -z "${seen}" ] || printf 'unidentified'
}

# Bounded: wait (polling every second) for the loop's first live process, then
# compare up to 3 times, all inside one 30 s deadline; the last attempt rules.
check_served_installed() {
  local installed served="" proc="" proc_pkg="" attempts=0 deadline=$((SECONDS + 30)) cmd_path
  installed="$(installed_piweb_version)"
  cmd_path="$(command -v pi-web 2>/dev/null || true)"
  [ -z "${cmd_path}" ] || served="$(piweb_package_of "${cmd_path}")"
  while [ "${attempts}" -lt 3 ] && [ "${SECONDS}" -lt "${deadline}" ]; do
    proc="$(running_piweb_script)"
    if [ -n "${proc}" ]; then
      attempts=$((attempts + 1))
      proc_pkg=""
      case "${proc}" in
        "path "*) proc_pkg="$(piweb_package_of "${proc#path }")" ;;
      esac
      if [ -n "${served}" ] && [ "${proc_pkg}" = "${served}" ] && [ "${served%%|*}" = "${installed}" ]; then
        echo "==> Served == installed: pi-web ${installed} (${served#*|})"
        return 0
      fi
      [ "${attempts}" -ge 3 ] && break
    fi
    sleep 1
  done
  # The running process's package is what is served; when it cannot be read,
  # fall back to the package PATH resolves to.
  local serving="${proc_pkg%%|*}"
  [ -n "${serving}" ] || serving="${served%%|*}"
  echo "warn: serving ${serving:-unknown}, installed ${installed}"
}

check_served_installed

# TLS edge probe: warn-only (the edge is not this script's service), single
# attempt, no retry. Only the operator's own first allowed host is probed;
# tunnel hostnames appended above are not an edge this script fronts.
EDGE_HOST="${PI_WEB_ALLOWED_HOSTS:-}"
EDGE_HOST="${EDGE_HOST%%,*}"
EDGE_HOST="$(printf '%s' "${EDGE_HOST}" | tr -d " \t\"'")"
if [ -z "${EDGE_HOST}" ]; then
  echo "==> PI_WEB_ALLOWED_HOSTS is empty; skipping the TLS edge probe."
elif ! command -v curl >/dev/null 2>&1; then
  echo "warn: TLS edge probe skipped: curl is not installed (${EDGE_HOST})"
else
  EDGE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "https://${EDGE_HOST}/" 2>/dev/null)" || EDGE_CODE=""
  if [ -n "${EDGE_CODE}" ] && [ "${EDGE_CODE}" != "000" ]; then
    echo "==> TLS edge probe OK: https://${EDGE_HOST}/ answered (${EDGE_CODE})"
  else
    echo "warn: TLS edge unreachable (${EDGE_HOST})"
  fi
fi

echo "==> pi-web running in tmux session '${SESSION}'"
tmux ls
