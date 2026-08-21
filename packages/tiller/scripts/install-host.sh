#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[tiller-install] %s\n' "$*"
}

fail() {
  printf '[tiller-install] Error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This installer currently supports Linux hosts only."
fi

if ! need_command apt-get; then
  fail "This installer currently supports Debian/Ubuntu-class hosts with apt-get."
fi

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  need_command sudo || fail "sudo is required when not running as root."
  SUDO="sudo"
fi

ensure_apt_package() {
  local package="$1"
  if dpkg -s "${package}" >/dev/null 2>&1; then
    return
  fi
  log "Installing ${package}..."
  ${SUDO} apt-get install -y "${package}"
}

log "Refreshing apt metadata..."
${SUDO} apt-get update

ensure_apt_package ca-certificates
ensure_apt_package curl
ensure_apt_package gnupg

NODE_MAJOR=""
if need_command node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi

if [[ "${NODE_MAJOR}" != "22" ]]; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO} -E bash -
  ${SUDO} apt-get install -y nodejs
fi

DOCKER_GROUP_ADDED=0
if ! need_command docker; then
  log "Installing Docker..."
  ${SUDO} apt-get install -y docker.io
fi

log "Ensuring Docker is enabled..."
${SUDO} systemctl enable --now docker

if need_command getent && ! getent group docker >/dev/null 2>&1; then
  ${SUDO} groupadd docker
fi

if ! id -nG "${USER}" | tr ' ' '\n' | grep -qx docker; then
  log "Adding ${USER} to the docker group..."
  ${SUDO} usermod -aG docker "${USER}"
  DOCKER_GROUP_ADDED=1
fi

log "Done. Prerequisites installed: Node.js 22, Docker."
printf '\n'
printf 'Next steps:\n'
printf '  1. Install Tiller: npm install -g @paperwing-dev/tiller@latest\n'
printf '  2. Run the full `tiller host setup --hub-url ...` command from Hub Settings\n'
printf '  3. Follow any service-persistence instructions printed by setup\n'
printf '  4. Verify: tiller status\n'

if [[ "${DOCKER_GROUP_ADDED}" -eq 1 ]]; then
  printf '\n'
  printf 'Docker group membership changed for %s.\n' "${USER}"
  printf 'Log out and back in, or run: newgrp docker\n'
fi
