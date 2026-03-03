#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="/opt/noxguard-exit-agent"
ENV_FILE="/etc/noxguard-exit-agent.env"
UNIT_FILE="/etc/systemd/system/noxguard-exit-agent.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)."
  exit 1
fi

install -d -m 0755 "$AGENT_DIR"
install -m 0755 "./agent.mjs" "$AGENT_DIR/agent.mjs"
install -m 0644 "./noxguard-exit-agent.service" "$UNIT_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "./env.example" "$ENV_FILE"
  echo "Wrote $ENV_FILE from env.example. Edit it and set EXIT_AGENT_TOKEN."
fi

systemctl daemon-reload
systemctl enable noxguard-exit-agent
echo "Installed. Start with: systemctl start noxguard-exit-agent"
