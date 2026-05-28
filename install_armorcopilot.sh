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
#   3. installs @armoriq/sdk-dev globally (for the `armoriq-dev` CLI)
#   4. registers the marketplace + installs the plugin in Copilot CLI:
#         copilot plugin marketplace add armoriq/armorCopilot
#         copilot plugin install armorcopilot@armorcopilot
#   5. runs `armoriq-dev login --product armorcopilot` for device-code auth
#
# Idempotent: re-running pulls the latest, reinstalls deps, refreshes marketplace.
#
# Flags:
#   --uninstall   remove the plugin + marketplace registration
#   --skip-login  don't prompt for ArmorIQ login at the end
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
MARKETPLACE_NAME="armorcopilot"
PLUGIN_NAME="armorcopilot"
PLUGIN_GIT_URL="${ARMORCOPILOT_GIT_URL:-https://github.com/armoriq/armorCopilot.git}"
PLUGIN_GIT_REF="${ARMORCOPILOT_GIT_REF:-main}"
INSTALL_HOME="${ARMORCOPILOT_INSTALL_HOME:-${HOME}/.armoriq/armorCopilot}"
DASHBOARD_URL="https://dev.armoriq.ai"

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
SKIP_LOGIN=0
for arg in "$@"; do
  case "$arg" in
    --uninstall)  DO_UNINSTALL=1 ;;
    --skip-login) SKIP_LOGIN=1 ;;
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
  if [[ -d node_modules/@armoriq/sdk-dev && -d node_modules/zod && -d node_modules/@modelcontextprotocol/sdk ]] \
    || [[ -d node_modules/@armoriq/sdk && -d node_modules/zod && -d node_modules/@modelcontextprotocol/sdk ]]; then
    info "npm dependencies already present"
  else
    info "installing npm dependencies (--omit=dev)"
    npm install --omit=dev --silent --no-audit --no-fund >/dev/null
    ok "npm dependencies installed"
  fi
  popd >/dev/null
}

install_armoriq_cli() {
  info "installing ArmorIQ CLI ${B}(@armoriq/sdk-dev)${N}"
  if npm install -g @armoriq/sdk-dev@latest --silent --no-audit --no-fund >/dev/null 2>&1; then
    ok "armoriq-dev CLI ready"
  else
    warn "couldn't install globally, use ${B}npx @armoriq/sdk-dev${N} instead"
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

connect_to_armoriq() {
  [[ "${SKIP_LOGIN}" -eq 1 ]] && return 0

  section "Connect to ArmorIQ"
  cat <<EOF

  Unlocks: signed JWT intent tokens, audit logs, CSRG proofs,
  and dashboard visibility for all intent plans at ${C}${DASHBOARD_URL}${N}.

EOF

  if ! is_promptable; then
    printf "  Run ${G}${B}armoriq-dev login --product armorcopilot${N} to connect later.\n\n"
    return 0
  fi

  if ! prompt_yes_no "Connect your ArmorIQ account now?" "Y"; then
    echo
    printf "  No problem. Run ${G}${B}armoriq-dev login --product armorcopilot${N} anytime.\n\n"
    return 0
  fi

  echo
  local product="armorcopilot"
  if command -v armoriq-dev >/dev/null 2>&1; then
    if armoriq-dev login --help 2>&1 | grep -q -- '--product'; then
      armoriq-dev login --product "${product}"
    else
      ARMORIQ_PRODUCT="${product}" armoriq-dev login
    fi
  elif command -v armoriq >/dev/null 2>&1; then
    if armoriq login --help 2>&1 | grep -q -- '--product'; then
      armoriq login --product "${product}"
    else
      ARMORIQ_PRODUCT="${product}" armoriq login
    fi
  elif command -v npx >/dev/null 2>&1; then
    if npx @armoriq/sdk-dev login --help 2>&1 | grep -q -- '--product'; then
      npx @armoriq/sdk-dev login --product "${product}"
    else
      ARMORIQ_PRODUCT="${product}" npx @armoriq/sdk-dev login
    fi
  else
    warn "armoriq CLI not found. Run ${B}npx @armoriq/sdk-dev login${N} manually."
    return 0
  fi

  local login_status=$?
  if [[ $login_status -eq 0 ]] && [[ -f "$HOME/.armoriq/credentials.json" ]]; then
    echo
    ok "ArmorIQ connected. Copilot will auto-load the key."
  fi
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

  section "Manage anytime"
  cat <<EOF

  ${D}bash $(realpath "${SCRIPT_PATH}" 2>/dev/null || echo install_armorcopilot.sh) --uninstall${N}

  Plugin:       ${C}${PLUGIN_PATH}${N}
  Copilot list: ${G}copilot plugin list${N}
  Docs:         ${C}https://github.com/armoriq/armorCopilot${N}

EOF
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
