#!/usr/bin/env bash
set -euo pipefail

# ArmorCopilot installer for GitHub Copilot CLI.
#
# Usage:
#   curl -fsSL https://armoriq.ai/install_armorcopilot.sh | bash
#
# Works two ways:
#   A. curl-pipe (no clone): fetches the plugin into ~/.armoriq/armorCopilot
#   B. From an existing checkout: cd armorCopilot && bash install_armorcopilot.sh
#
# What it wires:
#   1. clones the plugin to ~/.armoriq/armorCopilot
#   2. npm install --omit=dev for plugin runtime deps
#   3. installs @armoriq/sdk globally (for the `armoriq` CLI)
#   4. registers the marketplace + installs the plugin in Copilot CLI:
#         copilot plugin marketplace add armoriq/armorCopilot
#         copilot plugin install armorcopilot@armoriq
#   5. runs `armoriq login --product armorcopilot` for device-code auth
#
# Re-runs auto-detect mode: if the plugin and credentials are already in
# place the script runs in update mode (refresh checkout + SDK + npm deps,
# skip the login prompt). Fresh installs go through the full flow.
#
# Flags:
#   --uninstall       remove the plugin + marketplace registration
#   --force-install   force the full install flow even if already installed
#   --update          force update mode even without credentials
#
# Non-interactive overrides:
#   ARMORCOPILOT_MARKETPLACE_REPO   override marketplace source (testing)
#   ARMORCOPILOT_GIT_URL            override fork source (testing)
#   ARMORCOPILOT_GIT_REF            branch / tag (default main)
#   ARMORCOPILOT_INSTALL_HOME       where to clone (default ~/.armoriq/armorCopilot)

R=$'\033[1;31m'
G=$'\033[32m'
Y=$'\033[33m'
C=$'\033[38;2;0;229;204m'
M=$'\033[38;2;185;112;255m'
B=$'\033[1m'
D=$'\033[0;90m'
N=$'\033[0m'

MARKETPLACE_REPO="${ARMORCOPILOT_MARKETPLACE_REPO:-armoriq/armorCopilot}"
MARKETPLACE_NAME="armoriq"
PLUGIN_NAME="armorcopilot"
PLUGIN_GIT_URL="${ARMORCOPILOT_GIT_URL:-https://github.com/armoriq/armorCopilot.git}"
PLUGIN_GIT_REF="${ARMORCOPILOT_GIT_REF:-main}"
INSTALL_HOME="${ARMORCOPILOT_INSTALL_HOME:-${HOME}/.armoriq/armorCopilot}"
DASHBOARD_URL="https://platform.armoriq.ai"

# Recover if the caller is running this from a deleted directory (common when
# piping curl into bash from /tmp).
pwd >/dev/null 2>&1 || cd "${HOME:-/}"

# If invoked via `bash <(curl ...)` BASH_SOURCE may not point at a real file.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "${SCRIPT_PATH}" && -f "${SCRIPT_PATH}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
else
  SCRIPT_DIR=""
fi

PLUGIN_SUBDIR="plugins/armorcopilot"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/${PLUGIN_SUBDIR}/scripts/bootstrap.mjs" ]]; then
  PLUGIN_ROOT="${SCRIPT_DIR}"
else
  PLUGIN_ROOT="${INSTALL_HOME}"
fi
PLUGIN_PATH="${PLUGIN_ROOT}/${PLUGIN_SUBDIR}"
BOOTSTRAP_PATH="${PLUGIN_PATH}/scripts/bootstrap.mjs"

DO_UNINSTALL=0
FORCE_MODE=""
for arg in "$@"; do
  case "$arg" in
    --uninstall)      DO_UNINSTALL=1 ;;
    --force-install)  FORCE_MODE="install" ;;
    --update)         FORCE_MODE="update" ;;
    -h|--help)
      sed -n '4,32p' "${SCRIPT_PATH:-$0}" 2>/dev/null || true
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# UI helpers
# ---------------------------------------------------------------------------

ok()      { printf "${G}✔${N} %s\n" "$*"; }
warn()    { printf "${Y}!${N} %s\n" "$*"; }
err()     { printf "${R}✘${N} %s\n" "$*" 1>&2; }
info()    { printf "${D}·${N} %s\n" "$*"; }
section() { printf "\n${B}${M}┃ %s${N}\n" "$*"; }

banner() {
  cat <<EOF

${C}${B}   █████╗ ██████╗ ███╗   ███╗ ██████╗ ██████╗  ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗${N}
${C}${B}  ██╔══██╗██╔══██╗████╗ ████║██╔═══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝${N}
${C}${B}  ███████║██████╔╝██╔████╔██║██║   ██║██████╔╝██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║   ${N}
${C}${B}  ██╔══██║██╔══██╗██║╚██╔╝██║██║   ██║██╔══██╗██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║   ${N}
${C}${B}  ██║  ██║██║  ██║██║ ╚═╝ ██║╚██████╔╝██║  ██║╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║   ${N}
${C}${B}  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝   ${N}

      ${D}Intent-based security enforcement for GitHub Copilot CLI${N}
      ${D}Policy rules · Intent verification · CSRG proofs · Audit logging${N}

EOF
}

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    case "$1" in
      copilot) echo "  install GitHub Copilot CLI: curl -fsSL https://gh.io/copilot-install | bash" 1>&2 ;;
      node)    echo "  install Node.js >= 20 from https://nodejs.org" 1>&2 ;;
      git)     echo "  install git from https://git-scm.com/downloads" 1>&2 ;;
      npm)     echo "  npm comes bundled with Node.js" 1>&2 ;;
    esac
    exit 1
  fi
}

check_node_version() {
  local raw major
  raw="$(node --version 2>/dev/null || true)"
  major="$(printf '%s' "${raw#v}" | cut -d. -f1)"
  if [[ -z "${major}" || "${major}" -lt 20 ]]; then
    err "Node.js >= 20 required (found ${raw:-none})"
    exit 1
  fi
}

is_promptable() {
  [[ -e /dev/tty ]] || return 1
  (: < /dev/tty) 2>/dev/null || return 1
  return 0
}

prompt_yes_no() {
  local question="$1" default="${2:-Y}"
  local hint="(Y/n)"
  [[ "$default" == "N" ]] && hint="(y/N)"
  if ! is_promptable; then
    [[ "$default" == "Y" ]]; return $?
  fi
  printf "${B}?${N} %s ${D}%s${N} " "$question" "$hint" >&2
  local answer
  read -r answer < /dev/tty || answer=""
  [[ -z "$answer" ]] && { [[ "$default" == "Y" ]]; return $?; }
  [[ "$answer" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------------
# Plugin source + Copilot CLI wiring
# ---------------------------------------------------------------------------

fetch_plugin_source() {
  if [[ -f "${BOOTSTRAP_PATH}" ]]; then
    info "using existing checkout at ${PLUGIN_ROOT}"
    return 0
  fi

  mkdir -p "$(dirname "${INSTALL_HOME}")"

  if [[ -d "${INSTALL_HOME}/.git" ]]; then
    info "refreshing ${INSTALL_HOME} (git pull)"
    git -C "${INSTALL_HOME}" fetch --quiet origin "${PLUGIN_GIT_REF}" >/dev/null
    git -C "${INSTALL_HOME}" reset --hard --quiet "origin/${PLUGIN_GIT_REF}" >/dev/null
    ok "updated to ${PLUGIN_GIT_REF}"
  else
    info "cloning ${PLUGIN_GIT_URL} into ${INSTALL_HOME}"
    git clone --quiet --depth 1 --branch "${PLUGIN_GIT_REF}" "${PLUGIN_GIT_URL}" "${INSTALL_HOME}"
    ok "cloned to ${INSTALL_HOME}"
  fi

  PLUGIN_ROOT="${INSTALL_HOME}"
  PLUGIN_PATH="${PLUGIN_ROOT}/${PLUGIN_SUBDIR}"
  BOOTSTRAP_PATH="${PLUGIN_PATH}/scripts/bootstrap.mjs"
  if [[ ! -f "${BOOTSTRAP_PATH}" ]]; then
    err "fetched repo is missing ${PLUGIN_SUBDIR}/scripts/bootstrap.mjs"
    exit 1
  fi
}

install_npm_deps() {
  pushd "${PLUGIN_PATH}" >/dev/null
  if [[ -d node_modules/@armoriq/sdk && -d node_modules/zod && -d node_modules/@modelcontextprotocol/sdk ]] \
    || [[ -d node_modules/@armoriq/sdk-dev && -d node_modules/zod && -d node_modules/@modelcontextprotocol/sdk ]]; then
    info "npm dependencies already present"
  else
    info "installing npm dependencies (--omit=dev)"
    npm install --omit=dev --silent --no-audit --no-fund >/dev/null
    ok "npm dependencies installed"
  fi
  popd >/dev/null
}

install_armoriq_cli() {
  info "installing ArmorIQ CLI ${B}(@armoriq/sdk)${N}"
  if npm install -g @armoriq/sdk@latest --silent --no-audit --no-fund >/dev/null 2>&1; then
    ok "armoriq CLI ready"
  else
    warn "couldn't install globally, use ${B}npx @armoriq/sdk${N} instead"
  fi
}

register_marketplace_and_install() {
  # Marketplace add accepts owner/repo, URL, or a LOCAL PATH.
  # Use the local checkout when available (works without network for the
  # marketplace lookup) and otherwise fall back to the GitHub source.
  local marketplace_source="${MARKETPLACE_REPO}"
  if [[ -f "${PLUGIN_ROOT}/.claude-plugin/marketplace.json" ]]; then
    marketplace_source="${PLUGIN_ROOT}"
  fi

  info "registering marketplace ${marketplace_source}"
  if copilot plugin marketplace add "${marketplace_source}" >/dev/null 2>&1; then
    ok "marketplace registered"
  else
    info "marketplace add skipped (already added)"
  fi

  info "installing plugin ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
  if copilot plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1; then
    ok "plugin installed"
  else
    # On re-run the plugin may already be installed; refresh by uninstall/reinstall.
    copilot plugin uninstall "${PLUGIN_NAME}" >/dev/null 2>&1 || true
    if copilot plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1; then
      ok "plugin reinstalled (refreshed)"
    else
      err "failed to install plugin — try: copilot plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
      exit 1
    fi
  fi
}

verify_install() {
  section "Verifying"
  local issues=0
  if [[ ! -f "${BOOTSTRAP_PATH}" ]]; then
    warn "bootstrap.mjs missing at ${BOOTSTRAP_PATH}"
    issues=$((issues+1))
  fi
  if ! copilot plugin list 2>&1 | grep -q "${PLUGIN_NAME}@${MARKETPLACE_NAME}"; then
    warn "plugin not visible in 'copilot plugin list'"
    issues=$((issues+1))
  fi
  if [[ "${issues}" -eq 0 ]]; then
    ok "armorcopilot is wired up correctly"
  else
    warn "${issues} verification check(s) failed, see warnings above"
  fi
}

abort_install() {
  echo
  warn "Rolling back ArmorCopilot install..."
  copilot plugin uninstall "${PLUGIN_NAME}" >/dev/null 2>&1 || true
  copilot plugin marketplace remove "${MARKETPLACE_NAME}" >/dev/null 2>&1 || true
  if [[ -d "${INSTALL_HOME}" ]]; then
    rm -rf "${INSTALL_HOME}"
  fi
  echo
  err "ArmorCopilot requires an ArmorIQ account. Install aborted."
  printf "  Re-run when ready: ${B}curl -fsSL https://armoriq.ai/install_armorcopilot.sh | bash${N}\n\n"
  exit 1
}

connect_to_armoriq() {
  section "Connect to ArmorIQ"
  cat <<EOF

  ArmorCopilot requires an ArmorIQ account. Connecting unlocks signed JWT
  intent tokens, audit logs, CSRG proofs, and dashboard visibility for all
  intent plans at ${C}${DASHBOARD_URL}${N}.

EOF

  if [[ -n "${ARMORIQ_API_KEY:-}" ]] || [[ -f "$HOME/.armoriq/credentials.json" ]]; then
    ok "ArmorIQ credentials already present"
    return 0
  fi

  if ! is_promptable; then
    err "No TTY available for interactive login."
    printf "  Set ${B}ARMORIQ_API_KEY${N} or run interactively.\n"
    abort_install
  fi

  if ! prompt_yes_no "Connect your ArmorIQ account now?" "Y"; then
    abort_install
  fi

  echo
  local product="armorcopilot"
  local login_ok=0
  # Always pass --product as a flag AND export ARMORIQ_PRODUCT as a
  # belt-and-braces fallback. Do NOT probe with `login --help` first —
  # the SDK's `login` subcommand treats --help as an unknown flag and
  # runs the full device-code flow, which would open the browser an
  # extra time.
  #
  # Invocation strategy: route through `npx -p @armoriq/sdk armoriq`
  # so we always run the just-installed npm package, NOT whatever
  # `armoriq` happens to resolve to on PATH (some users have a Python
  # `armoriq` from PyPI in a conda env that wins the PATH lookup and
  # ships its own older unbranded callback page). npx with -p pins to
  # the exact package we want.
  export ARMORIQ_PRODUCT="${product}"
  if command -v npx >/dev/null 2>&1; then
    npx -p @armoriq/sdk armoriq login --product "${product}" \
      && login_ok=1 || login_ok=0
  elif command -v armoriq-dev >/dev/null 2>&1; then
    # Legacy fallback for users still on @armoriq/sdk-dev (pre-prod-flip).
    armoriq-dev login --product "${product}" && login_ok=1 || login_ok=0
  else
    err "Neither npx nor armoriq-dev found. ArmorCopilot requires npm/npx for login."
    abort_install
  fi

  if [[ "${login_ok}" -ne 1 ]] || [[ ! -f "$HOME/.armoriq/credentials.json" ]]; then
    err "ArmorIQ login did not complete."
    abort_install
  fi

  echo
  ok "ArmorIQ connected. Copilot will auto-load the key."
}

finale() {
  echo
  printf "${G}${B}ArmorCopilot is installed.${N}\n"

  section "Quick start"
  cat <<EOF

  Start a GitHub Copilot session in any project:

    ${G}${B}copilot${N}

  Try a prompt — ArmorCopilot will tell Copilot to register an intent plan
  first. Tools not in the plan get blocked (intent drift):

    ${D}> read README.md${N}
    ${D}> add a line "this is working" to README.md${N}

  Add policy rules from any prompt (natural language or "Policy ..."):

    ${D}> Policy new: deny webfetch${N}
    ${D}> update the policy to not access ~/photos${N}

EOF

  section "Learn more"
  cat <<EOF

  Docs:         ${C}${B}https://docs.armoriq.ai/armorcopilot${N}
  Source:       ${C}https://github.com/armoriq/armorCopilot${N}

EOF

  section "Manage anytime"
  cat <<EOF

  ${D}bash $(realpath "${SCRIPT_PATH}" 2>/dev/null || echo install_armorcopilot.sh) --uninstall${N}

  Plugin:       ${C}${PLUGIN_PATH}${N}
  Copilot list: ${G}copilot plugin list${N}

EOF
}

# ---------------------------------------------------------------------------
# Install mode detection
# ---------------------------------------------------------------------------

is_armorcopilot_installed() {
  [[ -f "${BOOTSTRAP_PATH}" ]] && copilot plugin list 2>/dev/null | grep -q "^[^#]*${PLUGIN_NAME}"
}

detect_mode() {
  if [[ -n "${FORCE_MODE}" ]]; then
    printf '%s' "${FORCE_MODE}"
    return 0
  fi
  if [[ -f "${HOME}/.armoriq/credentials.json" ]] && is_armorcopilot_installed; then
    printf 'update'
  else
    printf 'install'
  fi
}

run_update_path() {
  section "Refreshing plugin source"
  fetch_plugin_source

  section "Refreshing dependencies"
  pushd "${PLUGIN_PATH}" >/dev/null
  info "running npm install (--omit=dev) to pick up latest deps"
  npm install --omit=dev --silent --no-audit --no-fund >/dev/null \
    && ok "npm dependencies refreshed" \
    || warn "npm install failed, re-run manually if needed"
  popd >/dev/null
  install_armoriq_cli
}

finish_update_banner() {
  local sha=""
  if [[ -d "${INSTALL_HOME}/.git" ]]; then
    sha="$(git -C "${INSTALL_HOME}" rev-parse --short HEAD 2>/dev/null || true)"
  fi
  echo
  printf "${G}${B}ArmorCopilot is up to date.${N}\n\n"
  if [[ -n "${sha}" ]]; then
    info "Plugin: ${INSTALL_HOME} (refreshed to ${sha})"
  else
    info "Plugin: ${INSTALL_HOME} (refreshed)"
  fi
  info "SDK:    @armoriq/sdk (latest)"
  echo
  printf "  Docs: ${C}${B}https://docs.armoriq.ai/armorcopilot${N}\n\n"
}

uninstall() {
  section "Uninstalling ArmorCopilot"
  if copilot plugin uninstall "${PLUGIN_NAME}" >/dev/null 2>&1; then
    ok "plugin uninstalled"
  else
    info "plugin not installed (or already removed)"
  fi
  if copilot plugin marketplace remove "${MARKETPLACE_NAME}" >/dev/null 2>&1; then
    ok "marketplace removed"
  else
    info "marketplace not registered (or already removed)"
  fi
  info "Plugin source at ${INSTALL_HOME} left in place. Remove with: rm -rf ${INSTALL_HOME}"
}

main() {
  if [[ "${DO_UNINSTALL}" -eq 1 ]]; then
    uninstall
    exit 0
  fi

  banner

  section "Checking prerequisites"
  require_cmd copilot
  require_cmd node
  require_cmd npm
  require_cmd git
  check_node_version
  ok "prerequisites OK ($(copilot --version 2>/dev/null | head -1), $(node --version))"

  local mode
  mode="$(detect_mode)"
  if [[ "${mode}" == "update" ]]; then
    section "Updating ArmorCopilot"
    run_update_path
    verify_install
    finish_update_banner
    exit 0
  fi

  section "Fetching plugin source"
  fetch_plugin_source

  section "Installing dependencies"
  install_npm_deps
  install_armoriq_cli

  section "Registering Copilot CLI plugin"
  register_marketplace_and_install

  verify_install
  connect_to_armoriq
  finale
}

main "$@"
