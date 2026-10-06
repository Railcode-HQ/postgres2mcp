#!/usr/bin/env bash
#
# postgres2mcp installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Railcode-HQ/postgres2mcp/main/install.sh | bash
#
# Sets postgres2mcp up with Docker on this machine. Give it a Postgres
# connection string and, optionally, a domain: with a domain it waits for the
# DNS record to point here, then puts Caddy in front to obtain and renew the
# TLS certificate. Run it again at any time to update or to change a setting;
# it keeps what it was told before.
#
# Everything it asks can be passed instead (see --help), so it also runs
# unattended:
#
#   curl -fsSL …/install.sh | bash -s -- --yes \
#     --database-url postgres://user:pass@host:5432/db --domain mcp.example.com
#
# Works with bash 3.2+ (the one macOS ships) on Linux and macOS.

set -euo pipefail

REPO="${P2M_REPO:-https://github.com/Railcode-HQ/postgres2mcp}"
REF="${P2M_REF:-main}"

DATABASE_URL="${DATABASE_URL:-}"
DOMAIN="${P2M_DOMAIN:-}"
DIR="${P2M_DIR:-}"
PORT="${PORT:-}"
ASSUME_YES=0
SKIP_DNS=0
UNINSTALL=0
DNS_TIMEOUT="${P2M_DNS_TIMEOUT:-1800}"

# ── how it looks ─────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' BLUE=$'\033[34m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" RESET=""
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8* | *utf8* | *UTF8* | *utf-8*) OK="✓" BAD="✗" WARN="!" DOT="·" ARROW="→" FRAMES="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏" ;;
  *) OK="ok" BAD="x" WARN="!" DOT="-" ARROW="->" FRAMES="| / - \\" ;;
esac

ANIMATE=0
if [ -t 1 ]; then ANIMATE=1; fi

say() { printf '%s\n' "$*"; }
step_ok() { printf '  %s%s%s %s\n' "$GREEN" "$OK" "$RESET" "$*"; }
step_warn() { printf '  %s%s%s %s\n' "$YELLOW" "$WARN" "$RESET" "$*"; }
step_bad() { printf '  %s%s%s %s\n' "$RED" "$BAD" "$RESET" "$*" >&2; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }

# A failure says what happened and what to do about it, then stops.
die() {
  printf '\n' >&2
  step_bad "$1"
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  printf '\n' >&2
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/postgres2mcp-install.XXXXXX")"
SPINNER_PID=""
cleanup() {
  if [ -n "$SPINNER_PID" ]; then kill "$SPINNER_PID" 2>/dev/null || true; fi
  if [ "$ANIMATE" = 1 ]; then printf '\033[?25h'; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'printf "\n"; exit 130' INT

elapsed() {
  local seconds=$(($(date +%s) - $1))
  if [ "$seconds" -lt 60 ]; then printf '%ss' "$seconds"; else printf '%sm %02ss' $((seconds / 60)) $((seconds % 60)); fi
}

STEP_LOG="$WORK/step.log"

# draw FRAME "what is happening" "detail" ["shorter detail"]
# One status line, redrawn in place. A line wider than the terminal would wrap
# and could no longer be redrawn, so the detail is shortened or dropped to fit.
COLS=80
draw() {
  local room=$((COLS - 6)) text="$2" detail="$3"
  if [ $((${#text} + ${#detail} + 1)) -gt "$room" ]; then detail="${4:-}"; fi
  if [ $((${#text} + ${#detail} + 1)) -gt "$room" ]; then detail=""; fi
  if [ "${#text}" -gt "$room" ]; then text="${text:0:$room}"; fi
  printf '\r  %s%s%s %s %s%s%s\033[K' "$BLUE" "$1" "$RESET" "$text" "$DIM" "$detail" "$RESET"
}
start_drawing() {
  COLS="$(tput cols 2>/dev/null || echo 80)"
  case "$COLS" in "" | *[!0-9]*) COLS=80 ;; esac
  printf '\033[?25l'
}
stop_drawing() { printf '\r\033[K\033[?25h'; }

# spin "what is happening" command…
# Runs the command quietly behind a spinner and returns its exit status. Its
# output is in $STEP_LOG.
spin() {
  local doing="$1" started code=0
  shift
  started="$(date +%s)"
  if [ "$ANIMATE" = 1 ]; then
    "$@" >"$STEP_LOG" 2>&1 &
    SPINNER_PID=$!
    start_drawing
    while kill -0 "$SPINNER_PID" 2>/dev/null; do
      for frame in $FRAMES; do
        kill -0 "$SPINNER_PID" 2>/dev/null || break
        draw "$frame" "$doing" "$(elapsed "$started")"
        sleep 0.1
      done
    done
    wait "$SPINNER_PID" || code=$?
    SPINNER_PID=""
    stop_drawing
  else
    say "  $DOT $doing"
    "$@" >"$STEP_LOG" 2>&1 || code=$?
  fi
  SPIN_TOOK="$(elapsed "$started")"
  SPIN_SECONDS=$(($(date +%s) - started))
  return "$code"
}

# run "what is happening" "what happened" command…
# A step that has to work: if it fails, shows the end of its output and stops.
run() {
  local doing="$1" did="$2"
  shift 2
  if ! spin "$doing" "$@"; then
    step_bad "$doing: that failed. The last of its output:"
    printf '\n' >&2
    tail -n 25 "$STEP_LOG" | sed 's/^/    /' >&2
    printf '\n' >&2
    exit 1
  fi
  if [ "$SPIN_SECONDS" -ge 5 ]; then step_ok "$did ${DIM}($SPIN_TOOK)${RESET}"; else step_ok "$did"; fi
}

# ── asking ───────────────────────────────────────────────────────────────────

# `curl … | bash` leaves stdin holding the script, so questions go to the terminal itself.
TTY=""
if (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
can_ask() { [ "$ASSUME_YES" = 0 ] && [ -n "$TTY" ]; }

# ask VAR "Question" "hint shown dimmed"
ASKED=0
ask() {
  local answer=""
  ASKED=1
  printf '\n  %s%s%s\n' "$BOLD" "$2" "$RESET" >"$TTY"
  if [ -n "${3:-}" ]; then printf '  %s%s%s\n' "$DIM" "$3" "$RESET" >"$TTY"; fi
  printf '  %s>%s ' "$BLUE" "$RESET" >"$TTY"
  IFS= read -r answer <"$TTY" || true
  # Trim surrounding whitespace.
  answer="${answer#"${answer%%[![:space:]]*}"}"
  answer="${answer%"${answer##*[![:space:]]}"}"
  eval "$1=\$answer"
}

# confirm "Question" → 0 for yes. Yes is the default, and what --yes answers;
# with nobody to ask and no --yes, the answer is no.
confirm() {
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ -z "$TTY" ]; then return 1; fi
  local answer=""
  printf '\n  %s%s%s %s[Y/n]%s ' "$BOLD" "$1" "$RESET" "$DIM" "$RESET" >"$TTY"
  IFS= read -r answer <"$TTY" || true
  case "$answer" in "" | y | Y | yes | Yes) return 0 ;; *) return 1 ;; esac
}

usage() {
  cat <<EOF
postgres2mcp installer

  curl -fsSL https://raw.githubusercontent.com/Railcode-HQ/postgres2mcp/main/install.sh | bash

It asks for what it needs. To answer in advance, or to run unattended:

  --database-url URL    Postgres connection string of the database to expose   [DATABASE_URL]
  --domain NAME         Serve over HTTPS at this domain; the certificate is
                        obtained and renewed for you. Without it, the server
                        listens on a port over plain HTTP.                      [P2M_DOMAIN]
  --port N              The port, when there is no domain (default 3333)       [PORT]
  --dir PATH            Where to install (default ~/postgres2mcp, or
                        /opt/postgres2mcp as root)                             [P2M_DIR]
  --skip-dns-check      Do not wait for the domain to point at this machine
  -y, --yes             Do not ask anything; fail if something is missing
  --uninstall           Stop postgres2mcp and say how to remove what is left
  -h, --help            This text

With arguments, pass them through bash:  curl -fsSL …/install.sh | bash -s -- --domain mcp.example.com

Run it again to update to the latest version or to change a setting. What it
was told before is kept in <dir>/.env.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --database-url | -d) DATABASE_URL="${2:?--database-url needs a value}"; shift 2 ;;
    --database-url=*) DATABASE_URL="${1#*=}"; shift ;;
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --port | -p) PORT="${2:?--port needs a value}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help | -h) usage; exit 0 ;;
    *) die "Unknown option: $1" "Run with --help to see what it accepts." ;;
  esac
done

# ── small tools ──────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }

# /home/you/postgres2mcp → ~/postgres2mcp, for printing.
tilde() {
  # shellcheck disable=SC2088  # a literal tilde is the point
  case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac
}

# The settings file is KEY='value' lines; these read and write one key and
# leave every other line (including ones you added) alone.
env_get() {
  [ -f "$DIR/.env" ] || return 0
  local value
  value="$(sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1)"
  case "$value" in
    \'*\') value="${value#\'}"; value="${value%\'}"; value="${value//\\\'/\'}" ;;
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
  esac
  printf '%s' "$value"
}

env_set() {
  local file="$DIR/.env" escaped
  escaped="${2//\'/\\\'}"
  touch "$file"
  chmod 600 "$file"
  { grep -v "^$1=" "$file" || true; } >"$file.tmp"
  printf "%s='%s'\n" "$1" "$escaped" >>"$file.tmp"
  mv "$file.tmp" "$file"
  chmod 600 "$file"
}

# postgres://user:secret@host/db → postgres://user:••••@host/db
mask_url() {
  local url="$1" scheme rest authority tail
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%[/?]*}"
  tail="${rest#"$authority"}"
  case "$authority" in
    *:*@*) printf '%s://%s:****@%s%s' "$scheme" "${authority%%:*}" "${authority##*@}" "$tail" ;;
    *) printf '%s' "$url" ;;
  esac
}

# The host part of a connection string, without credentials or port.
url_host() {
  local rest authority hostport
  rest="${1#*://}"
  authority="${rest%%[/?]*}"
  hostport="${authority##*@}"
  case "$hostport" in
    \[*) printf '%s' "${hostport%%]*}]" ;;
    *) printf '%s' "${hostport%%:*}" ;;
  esac
}

# Inside a container, "localhost" is the container. A database on this machine
# is reached through the name Docker gives the host.
url_for_container() {
  local url="$1" scheme rest authority tail userinfo="" hostport
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%[/?]*}"
  tail="${rest#"$authority"}"
  hostport="$authority"
  case "$authority" in *@*) userinfo="${authority%@*}@"; hostport="${authority##*@}" ;; esac
  case "$hostport" in
    localhost | 127.0.0.1 | "[::1]") hostport="host.docker.internal" ;;
    localhost:* | 127.0.0.1:*) hostport="host.docker.internal:${hostport##*:}" ;;
    "[::1]":*) hostport="host.docker.internal:${hostport##*]:}" ;;
  esac
  printf '%s://%s%s%s' "$scheme" "$userinfo" "$hostport" "$tail"
}

random_hex() {
  if have openssl; then openssl rand -hex 16; else od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; fi
}

fetch() { curl -fsS --max-time "${2:-6}" "$1" 2>/dev/null; }

# This machine's address as the internet sees it.
public_ip() {
  local flag="$1" ip="" source
  for source in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    if [ "$flag" = -6 ] && [ "$source" = https://api.ipify.org ]; then source=https://api6.ipify.org; fi
    ip="$(curl "$flag" -fsS --max-time 5 "$source" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$ip" in *[!0-9a-fA-F.:]* | "") ip="" ;; *) break ;; esac
  done
  printf '%s' "$ip"
}

# resolve NAME A|AAAA → the records, one per line. Asked of public resolvers
# over HTTPS, so a stale local cache does not hide a record that has just been
# created (and neither dig nor nslookup needs to be installed).
resolve() {
  local name="$1" kind="$2" number=1 answer="" endpoint
  if [ "$kind" = AAAA ]; then number=28; fi
  for endpoint in "https://cloudflare-dns.com/dns-query" "https://dns.google/resolve"; do
    answer="$(curl -fsS --max-time 6 -H 'accept: application/dns-json' "$endpoint?name=$name&type=$kind" 2>/dev/null || true)"
    if [ -n "$answer" ]; then
      printf '%s' "$answer" | tr '{' '\n' | grep -E "\"type\" ?: ?${number}[,}]" |
        sed -E -n 's/.*"data" ?: ?"([^"]*)".*/\1/p' || true
      return 0
    fi
  done
  if have dig; then
    dig +short "$kind" "$name" 2>/dev/null | grep -E '^[0-9a-fA-F.:]+$' || true
  elif have getent && [ "$kind" = A ]; then
    getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u || true
  fi
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ── what to install, and where ───────────────────────────────────────────────

say ""
say "  ${BOLD}postgres2mcp${RESET}  ${DIM}your Postgres database, as an MCP server${RESET}"

have curl || die "curl is needed, and is not installed." "Install it with your package manager (apt install curl, dnf install curl, brew install curl) and run this again."

# Run from inside a checkout, the installer sets up that checkout.
HERE=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
IN_CHECKOUT=0
if [ -z "$DIR" ] && [ -n "$HERE" ] && [ -f "$HERE/Dockerfile" ] && [ -f "$HERE/src/bin.ts" ]; then
  DIR="$HERE"
  IN_CHECKOUT=1
fi
if [ -z "$DIR" ]; then
  if [ "$(id -u)" = 0 ]; then DIR=/opt/postgres2mcp; else DIR="$HOME/postgres2mcp"; fi
fi

EXISTING=0
if [ -f "$DIR/.env" ] && [ -f "$DIR/docker-compose.yml" ]; then EXISTING=1; fi

# ── Docker ───────────────────────────────────────────────────────────────────

DOCKER="docker"
compose() { $DOCKER compose --project-directory "$DIR" "$@"; }

need_docker() {
  if ! have docker; then
    if [ "$(uname -s)" = Linux ] && confirm "Docker is not installed. Install it now with Docker's own script (get.docker.com)?"; then
      local sudo=""
      if [ "$(id -u)" != 0 ]; then sudo="sudo"; fi
      curl -fsSL https://get.docker.com -o "$WORK/get-docker.sh"
      run "Installing Docker" "Installed Docker" $sudo sh "$WORK/get-docker.sh"
    else
      die "Docker is needed, and is not installed." \
        "Linux:  curl -fsSL https://get.docker.com | sh" \
        "macOS:  https://docs.docker.com/desktop/setup/install/mac-install/" \
        "Then run this installer again."
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    if [ "$(id -u)" != 0 ] && have sudo && sudo docker info >/dev/null 2>&1; then
      DOCKER="sudo docker"
    else
      die "Docker is installed, but not answering." \
        "Start it (Linux: sudo systemctl start docker; macOS: open the Docker app) and run this again." \
        "If it is running, your user may not be allowed to use it: sudo usermod -aG docker \$USER, then sign in again."
    fi
  fi
  if ! $DOCKER compose version >/dev/null 2>&1; then
    die "Docker Compose v2 is needed (the \"docker compose\" command)." \
      "Install the compose plugin: https://docs.docker.com/compose/install/linux/" \
      "Then run this installer again."
  fi
  step_ok "Docker $($DOCKER version --format '{{.Server.Version}}' 2>/dev/null || echo '') with Compose $($DOCKER compose version --short 2>/dev/null || echo '')"
}

# ── uninstall ────────────────────────────────────────────────────────────────

if [ "$UNINSTALL" = 1 ]; then
  say ""
  [ "$EXISTING" = 1 ] || die "No postgres2mcp install found in $DIR." "If it lives elsewhere, pass --dir."
  need_docker
  if [ "$ASSUME_YES" = 0 ] && [ -z "$TTY" ]; then die "Nobody to confirm with." "Pass --yes to stop postgres2mcp without being asked."; fi
  confirm "Stop postgres2mcp in $DIR? Its data (accounts, keys, tools, logs) is kept." || exit 0
  run "Stopping postgres2mcp" "Stopped postgres2mcp" compose --profile tls down
  say ""
  say "  Its settings and data are still here, so starting it again brings everything back:"
  say "    ${DIM}cd $(tilde "$DIR") && docker compose up -d${RESET}"
  say "  To remove it completely, data included:"
  say "    ${DIM}cd $(tilde "$DIR") && docker compose --profile tls down --volumes && cd .. && rm -rf $(tilde "$DIR")${RESET}"
  say ""
  exit 0
fi

# ── the two questions ────────────────────────────────────────────────────────

say ""
if [ "$EXISTING" = 1 ]; then
  step_ok "Found an install in ${BOLD}$(tilde "$DIR")${RESET}: updating it, keeping its settings"
  [ -n "$DATABASE_URL" ] || DATABASE_URL="$(env_get DATABASE_URL)"
  [ -n "$DOMAIN" ] || DOMAIN="$(env_get P2M_DOMAIN)"
  [ -n "$PORT" ] || PORT="$(env_get PORT)"
fi

valid_database_url() { case "$1" in postgres://?* | postgresql://?*) return 0 ;; *) return 1 ;; esac; }

if [ -z "$DATABASE_URL" ]; then
  can_ask || die "No database to expose." "Pass --database-url postgres://user:password@host:5432/dbname (or set DATABASE_URL)."
  while :; do
    ask DATABASE_URL "Which database should it expose?" "A Postgres connection string: postgres://user:password@host:5432/dbname"
    if valid_database_url "$DATABASE_URL"; then break; fi
    printf '  %sThat does not look like a connection string. It starts with postgres:// or postgresql://%s\n' "$YELLOW" "$RESET" >"$TTY"
  done
fi
valid_database_url "$DATABASE_URL" || die "\"$(mask_url "$DATABASE_URL")\" is not a Postgres connection string." "It should look like postgres://user:password@host:5432/dbname"

# A domain as people type it: with a scheme, a path, capitals. Reduced to the name.
clean_domain() {
  local name="$1"
  name="${name#http://}"
  name="${name#https://}"
  name="${name%%/*}"
  printf '%s' "$name" | tr '[:upper:]' '[:lower:]'
}
valid_domain() {
  [ "$1" = localhost ] || printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'
}

if [ -z "$DOMAIN" ] && [ "$EXISTING" = 0 ] && can_ask; then
  while :; do
    ask DOMAIN "Domain for HTTPS?" "Like mcp.example.com. The certificate is handled for you. Leave empty to use port ${PORT:-3333} without TLS."
    DOMAIN="$(clean_domain "$DOMAIN")"
    if [ -z "$DOMAIN" ] || valid_domain "$DOMAIN"; then break; fi
    printf '  %sThat is not a domain name. Enter something like mcp.example.com, or nothing.%s\n' "$YELLOW" "$RESET" >"$TTY"
  done
fi
DOMAIN="$(clean_domain "$DOMAIN")"
if [ -n "$DOMAIN" ]; then
  valid_domain "$DOMAIN" || die "\"$DOMAIN\" is not a domain name." "Pass something like --domain mcp.example.com"
fi
PORT="${PORT:-3333}"
case "$PORT" in *[!0-9]* | "") die "\"$PORT\" is not a port number." ;; esac

# After questions were asked, a blank line sets the progress apart from them.
if [ "$ASKED" = 1 ]; then say ""; fi

# ── checks before anything is changed ────────────────────────────────────────

need_docker

running() { [ -n "$(compose ps --quiet --status running "$1" 2>/dev/null || true)" ]; }

if [ -n "$DOMAIN" ]; then
  if [ "$EXISTING" = 0 ] || ! running caddy; then
    for port in 80 443; do
      if port_in_use "$port"; then
        die "Port $port is already in use on this machine." \
          "HTTPS for $DOMAIN needs ports 80 and 443 (often it is nginx or Apache holding them)." \
          "Either stop that program, or run this without --domain and point your own" \
          "reverse proxy at port $PORT: see docs/deployment.md, \"Behind your own reverse proxy\"."
      fi
    done
    step_ok "Ports 80 and 443 are free"
  fi
elif [ "$EXISTING" = 0 ] && port_in_use "$PORT"; then
  die "Port $PORT is already in use on this machine." "Choose another with --port, for example --port 3334."
fi

# With a domain, say what DNS needs to hold now: the record can be created
# while the image builds.
SERVER_IP=""
DNS_READY=0
dns_points_here() { [ -n "$SERVER_IP" ] && resolve "$DOMAIN" A | grep -qx "$SERVER_IP"; }

if [ -n "$DOMAIN" ] && [ "$DOMAIN" != localhost ] && [ "$SKIP_DNS" = 0 ]; then
  SERVER_IP="$(public_ip -4)"
  if [ -z "$SERVER_IP" ]; then
    step_warn "Could not work out this machine's public address, so DNS for $DOMAIN was not checked"
    SKIP_DNS=1
  elif dns_points_here; then
    DNS_READY=1
    step_ok "$DOMAIN points to this machine ${DIM}($SERVER_IP)${RESET}"
  else
    step_warn "$DOMAIN does not point to this machine yet. Create this DNS record now:"
    say ""
    say "        ${DIM}Type${RESET}   ${DIM}Name${RESET}$(printf '%*s' $((${#DOMAIN} - 2)) '')${DIM}Value${RESET}"
    say "        ${BOLD}A${RESET}      ${BOLD}$DOMAIN${RESET}  ${BOLD}$SERVER_IP${RESET}"
    say ""
    note "It can spread while the image builds; the install waits for it before asking for a certificate."
    note "On Cloudflare, set the record to \"DNS only\" (grey cloud)."
  fi
fi

# ── fetch ────────────────────────────────────────────────────────────────────

fetch_source() {
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" pull --ff-only --quiet
  elif have git && [ ! -e "$DIR/docker-compose.yml" ]; then
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
  else
    mkdir -p "$DIR"
    curl -fsSL "$REPO/archive/$REF.tar.gz" | tar -xz --strip-components=1 -C "$DIR"
  fi
}

if [ "$IN_CHECKOUT" = 1 ]; then
  step_ok "Using this checkout: ${BOLD}$(tilde "$DIR")${RESET}"
else
  if [ -e "$DIR" ] && [ "$EXISTING" = 0 ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and is not a postgres2mcp install." "Choose another place with --dir, or move that directory away."
  fi
  if [ "$EXISTING" = 1 ]; then
    run "Fetching the latest postgres2mcp" "Fetched the latest postgres2mcp" fetch_source
  else
    run "Fetching postgres2mcp into $(tilde "$DIR")" "Fetched postgres2mcp into ${BOLD}$(tilde "$DIR")${RESET}" fetch_source
  fi
fi

# ── settings ─────────────────────────────────────────────────────────────────

LOCAL_DATABASE=0
case "$(url_host "$DATABASE_URL")" in
  localhost | 127.0.0.1 | "[::1]")
    LOCAL_DATABASE=1
    DATABASE_URL="$(url_for_container "$DATABASE_URL")"
    ;;
  host.docker.internal) LOCAL_DATABASE=1 ;;
esac

write_settings() {
  env_set DATABASE_URL "$DATABASE_URL"
  env_set PORT "$PORT"
  env_set P2M_DOMAIN "$DOMAIN"
  if [ -n "$DOMAIN" ]; then
    env_set COMPOSE_PROFILES tls
    env_set P2M_PUBLIC_URL "https://$DOMAIN"
    # Caddy is the way in; the port itself is only reachable from this machine.
    env_set P2M_BIND 127.0.0.1
  else
    env_set COMPOSE_PROFILES ""
    env_set P2M_PUBLIC_URL ""
    env_set P2M_BIND "$(env_get P2M_BIND | grep . || echo 0.0.0.0)"
  fi
  # The first account can only be created by someone holding this code.
  if [ -z "$(env_get P2M_SETUP_TOKEN)" ]; then env_set P2M_SETUP_TOKEN "$(random_hex)"; fi
}
write_settings

# ── build and start ──────────────────────────────────────────────────────────

if [ "$EXISTING" = 1 ]; then
  run "Rebuilding the image" "Rebuilt the image" compose build postgres2mcp
else
  run "Building the image (the first build takes a minute or two)" "Built the image" compose build postgres2mcp
fi
run "Starting postgres2mcp" "Started postgres2mcp" compose up --detach --no-build postgres2mcp

LOCAL="http://127.0.0.1:$PORT"

wait_for_server() {
  local tries=0
  while [ "$tries" -lt 90 ]; do
    if fetch "$LOCAL/api/auth/state" 3 >/dev/null; then return 0; fi
    sleep 1
    tries=$((tries + 1))
  done
  # What the container said, for the failure report.
  compose logs --no-color --tail 30 postgres2mcp 2>&1 || true
  return 1
}
run "Waiting for the server to answer" "The server answers" wait_for_server

# The database gets a few tries: a first connection can be slow to establish.
database_answers() {
  local tries=0
  while [ "$tries" -lt 4 ]; do
    if fetch "$LOCAL/api/health" 10 | grep -q '"database":true'; then return 0; fi
    sleep 2
    tries=$((tries + 1))
  done
  return 1
}
database_error() {
  compose logs --no-color --tail 200 postgres2mcp 2>/dev/null | sed -n 's/.*NOT CONNECTED — //p' | tail -n 1
}

DATABASE_OK=0
while :; do
  if spin "Checking the database" database_answers; then DATABASE_OK=1; break; fi
  step_warn "The server is up, but the database did not answer:"
  say "      ${YELLOW}$(database_error | grep . || echo "no answer from $(url_host "$DATABASE_URL")")${RESET}"
  if [ "$LOCAL_DATABASE" = 1 ]; then
    note "The database is on this machine, so the container reaches it as host.docker.internal."
    note "Postgres has to listen beyond localhost (listen_addresses) and allow Docker's networks"
    note "in pg_hba.conf (172.16.0.0/12). See docs/deployment.md, \"A database on the same machine\"."
  else
    note "Check the host, port, user and password, and that the database accepts connections from this machine."
  fi
  if ! can_ask; then
    step_warn "Continuing anyway. Fix it with: --database-url <the right one> (run this installer again)"
    break
  fi
  ask REPLY_URL "Enter a different connection string, or press Enter to continue anyway" "Currently: $(mask_url "$DATABASE_URL")"
  if [ -z "$REPLY_URL" ]; then break; fi
  if ! valid_database_url "$REPLY_URL"; then
    printf '  %sThat does not look like a connection string.%s\n' "$YELLOW" "$RESET" >"$TTY"
    continue
  fi
  DATABASE_URL="$REPLY_URL"
  LOCAL_DATABASE=0
  case "$(url_host "$DATABASE_URL")" in
    localhost | 127.0.0.1 | "[::1]") LOCAL_DATABASE=1; DATABASE_URL="$(url_for_container "$DATABASE_URL")" ;;
  esac
  env_set DATABASE_URL "$DATABASE_URL"
  say ""
  run "Restarting with the new connection string" "Restarted" compose up --detach --no-build postgres2mcp
  run "Waiting for the server to answer" "The server answers" wait_for_server
done
if [ "$DATABASE_OK" = 1 ]; then step_ok "The database answers ${DIM}($(mask_url "$DATABASE_URL"))${RESET}"; fi

# ── domain: wait for DNS, then get the certificate ───────────────────────────

HTTPS_LIVE=0
if [ -n "$DOMAIN" ]; then
  if [ "$DOMAIN" != localhost ] && [ "$SKIP_DNS" = 0 ] && [ "$DNS_READY" = 0 ]; then
    started="$(date +%s)"
    skipped=0
    if [ "$ANIMATE" = 1 ]; then start_drawing; fi
    while ! dns_points_here; do
      waited=$(($(date +%s) - started))
      if [ "$waited" -ge "$DNS_TIMEOUT" ]; then
        if [ "$ANIMATE" = 1 ]; then stop_drawing; fi
        die "$DOMAIN still does not point to $SERVER_IP after $(elapsed "$started")." \
          "postgres2mcp is running, but without a certificate yet. Once the A record is in place," \
          "run this installer again: it picks up where it stopped." \
          "(Behind a proxy such as Cloudflare the name never points here; use --skip-dns-check.)"
      fi
      current="$(resolve "$DOMAIN" A | tr '\n' ' ' | sed 's/ *$//; s/ /, /g')"
      hint=""
      if can_ask; then hint=" $DOT press s to skip"; fi
      if [ "$ANIMATE" = 1 ]; then
        for frame in $FRAMES; do
          draw "$frame" "Waiting for $DOMAIN $ARROW $SERVER_IP" \
            "now: ${current:-no record} $DOT $(elapsed "$started")$hint" "$(elapsed "$started")$hint"
          key=""
          if can_ask; then
            IFS= read -r -s -n 1 -t 1 key <"$TTY" || true
          else
            sleep 1
          fi
          if [ "$key" = s ] || [ "$key" = S ]; then skipped=1; break 2; fi
        done
      else
        say "  $DOT Waiting for $DOMAIN to point to $SERVER_IP (now: ${current:-no record})"
        sleep 15
      fi
    done
    if [ "$ANIMATE" = 1 ]; then stop_drawing; fi
    if [ "$skipped" = 1 ]; then
      step_warn "Not waiting for DNS. The certificate can only be issued once $DOMAIN reaches this machine"
    else
      step_ok "$DOMAIN points to this machine ${DIM}($SERVER_IP, after $(elapsed "$started"))${RESET}"
    fi
  fi

  # A name that also has an IPv6 record pointing elsewhere fails validation half the time.
  if [ "$DOMAIN" != localhost ] && [ "$SKIP_DNS" = 0 ]; then
    v6_records="$(resolve "$DOMAIN" AAAA | tr '\n' ' ')"
    if [ -n "$v6_records" ]; then
      server_v6="$(public_ip -6)"
      if [ -z "$server_v6" ] || ! printf '%s' "$v6_records" | tr ' ' '\n' | grep -qix "$server_v6"; then
        step_warn "$DOMAIN also has an AAAA (IPv6) record that does not lead here: ${v6_records% }"
        note "Remove it, or point it at this machine, if the certificate does not arrive."
      fi
    fi
  fi

  run "Starting Caddy" "Started Caddy" compose up --detach --no-build

  https_answers() {
    local insecure=""
    if [ "$DOMAIN" = localhost ]; then insecure="--insecure"; fi
    local tries=0
    while [ "$tries" -lt 60 ]; do
      if curl -fsS $insecure --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then return 0; fi
      sleep 3
      tries=$((tries + 1))
    done
    return 1
  }
  if spin "Getting a certificate for $DOMAIN" https_answers; then HTTPS_LIVE=1; fi
  if [ "$HTTPS_LIVE" = 1 ]; then
    step_ok "HTTPS is live at ${BOLD}https://$DOMAIN${RESET} ${DIM}(certificate obtained, renewed automatically)${RESET}"
  else
    step_warn "https://$DOMAIN is not answering yet. Caddy keeps trying; what it last said:"
    compose logs --no-color --tail 200 caddy 2>/dev/null | grep -iE '"level":"error"|error' | tail -n 3 | cut -c 1-300 | sed 's/^/      /' || true
    note "Usual causes: the DNS record is missing or still spreading, a firewall blocks ports 80/443,"
    note "or a proxy in front (Cloudflare's orange cloud) intercepts the request."
    note "Follow along with: cd $(tilde "$DIR") && docker compose logs -f caddy"
  fi
fi

# ── done ─────────────────────────────────────────────────────────────────────

if [ -n "$DOMAIN" ]; then
  ADDRESS="https://$DOMAIN"
else
  ADDRESS="http://localhost:$PORT"
  # Installed over SSH: the browser is on another machine, so localhost is the wrong name to print.
  if [ -n "${SSH_CONNECTION:-}" ]; then
    [ -n "$SERVER_IP" ] || SERVER_IP="$(public_ip -4)"
    if [ -n "$SERVER_IP" ]; then ADDRESS="http://$SERVER_IP:$PORT"; fi
  fi
fi
SETUP_NEEDED=0
if fetch "$LOCAL/api/auth/state" | grep -q '"setup_required":true'; then SETUP_NEEDED=1; fi

say ""
if [ -z "$DOMAIN" ] || [ "$HTTPS_LIVE" = 1 ]; then
  say "  ${GREEN}${BOLD}postgres2mcp is running.${RESET}"
else
  say "  ${YELLOW}${BOLD}postgres2mcp is running, and waiting for its certificate.${RESET}"
fi
say ""
if [ "$SETUP_NEEDED" = 1 ]; then
  say "  ${BOLD}Next: create your admin account${RESET} ${DIM}(this link is what lets you, and only you, do that)${RESET}"
  say ""
  say "    ${BLUE}${BOLD}$ADDRESS/?setup=$(env_get P2M_SETUP_TOKEN)${RESET}"
  say ""
  say "  The dashboard then walks you through connecting your first MCP client."
else
  say "  Dashboard      ${BLUE}${BOLD}$ADDRESS${RESET}"
fi
say ""
WHERE="$(tilde "$DIR")"
say "  ${DIM}MCP endpoint${RESET}   $ADDRESS/mcp"
say "  ${DIM}Installed in${RESET}   $WHERE  ${DIM}(settings in .env)${RESET}"
say ""
say "  ${DIM}Logs${RESET}           cd $WHERE && docker compose logs -f"
say "  ${DIM}Update${RESET}         run this installer again"
say "  ${DIM}Stop${RESET}           cd $WHERE && docker compose down"
if [ -z "$DOMAIN" ]; then
  say ""
  step_warn "This is plain HTTP on port $PORT: fine on your own machine or a private network."
  note "For a server others can reach, run the installer again with --domain your.domain to add HTTPS."
fi
say ""

if [ -n "$DOMAIN" ] && [ "$HTTPS_LIVE" = 0 ]; then exit 2; fi
