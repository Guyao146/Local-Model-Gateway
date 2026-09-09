#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker was not found. Install Docker Engine and the Docker Compose Plugin first." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Error: Docker Compose Plugin was not found. Verify that 'docker compose' works." >&2
  exit 1
fi

PORT_VALUE="${GATEWAY_PORT:-8787}"
if [[ ! "$PORT_VALUE" =~ ^[0-9]+$ ]] || (( PORT_VALUE < 1 || PORT_VALUE > 65535 )); then
  echo "Error: GATEWAY_PORT must be an integer between 1 and 65535." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  sed -i "s/^GATEWAY_PORT=.*/GATEWAY_PORT=$PORT_VALUE/" .env
  echo "Created .env. Configure Authentik there if remote administration is needed: $ROOT_DIR/.env"
else
  echo "Using existing configuration: $ROOT_DIR/.env"
fi

docker compose pull
docker compose up -d --remove-orphans

echo "Waiting for the gateway health check..."
for attempt in {1..30}; do
  if docker compose exec -T gateway node -e "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    echo "Deployment succeeded:"
    echo "  http://SERVER_IP:$PORT_VALUE/"
    echo "  OpenAI Base URL: http://SERVER_IP:$PORT_VALUE/v1"
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "Deployment failed. Recent logs:" >&2
docker compose logs --tail=100 gateway >&2
exit 1