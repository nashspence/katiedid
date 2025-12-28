#!/usr/bin/env bash
set -euo pipefail

SSH_DIR="$HOME/.ssh"
SSH_ENV="$SSH_DIR/agent.env"
AGENT_SOCK="$SSH_DIR/ssh-agent.sock"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [[ -S "${SSH_AUTH_SOCK:-}" ]]; then
  ACTIVE_SOCK="$SSH_AUTH_SOCK"
  echo "Using forwarded SSH agent: $ACTIVE_SOCK"
else
  ACTIVE_SOCK="$AGENT_SOCK"
  if [[ ! -S "$ACTIVE_SOCK" ]]; then
    eval "$(ssh-agent -a "$ACTIVE_SOCK")" >/dev/null
    echo "Started container ssh-agent: $ACTIVE_SOCK"
  fi
fi

printf 'export SSH_AUTH_SOCK=%q\n' "$ACTIVE_SOCK" > "$SSH_ENV"

touch "$HOME/.bashrc"
grep -qs '\.ssh/agent\.env' "$HOME/.bashrc" 2>/dev/null || \
  echo "[ -f \"$SSH_ENV\" ] && . \"$SSH_ENV\"" >> "$HOME/.bashrc"

command -v gh >/dev/null && gh --version || true
