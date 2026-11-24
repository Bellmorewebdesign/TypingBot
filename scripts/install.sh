#!/usr/bin/env bash
# Install or upgrade the TypingBot backend on this PC. Safe to run repeatedly.
#  - never overwrites or edits an existing .env (your Anthropic key and mode are kept)
#  - makes Docker start at boot; the container has restart: unless-stopped, so TypingBot comes back after a reboot
#  - publishes the service on 127.0.0.1 only (this PC)
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Docker is not installed. Install Docker Engine and the compose plugin first." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The 'docker compose' plugin is missing." >&2; exit 1; }

if command -v systemctl >/dev/null 2>&1 && ! systemctl is-enabled --quiet docker 2>/dev/null; then
  echo "Enabling Docker at boot (needs sudo once)..."
  sudo systemctl enable docker
fi

if [ -f .env ]; then
  echo "Keeping your existing .env"
else
  (umask 077; printf 'MODEL_MODE=mock\nANTHROPIC_API_KEY=\n' > .env)
  echo "Created .env in mock mode (no API spend). Edit it to add your key and set MODEL_MODE=live."
fi

docker compose up --build -d

for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:4317/health >/dev/null 2>&1; then
    echo "TypingBot is running on http://127.0.0.1:4317 (this PC only)."
    exit 0
  fi
  sleep 1
done
echo "TypingBot did not answer within 40 seconds. Check: docker compose logs typingbot" >&2
exit 1
