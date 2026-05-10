#!/usr/bin/env bash
# Wrapper around `agentcore deploy` that always re-injects the runtime
# environment variables from .env. The Bedrock AgentCore CLI does not
# persist env vars across deploys (each create_or_update_agent call
# overwrites them with whatever is passed in env_vars), so we read .env
# and translate each KEY=VALUE line into a -env flag.

set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${1:-.env}"
shift || true

if [[ ! -f "$ENV_FILE" ]]; then
  echo "env file not found: $ENV_FILE" >&2
  exit 1
fi

env_args=()
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip blank lines and comments
  [[ -z "${line// }" || "${line:0:1}" == "#" ]] && continue
  # Trim leading/trailing whitespace
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue
  env_args+=(-env "$line")
done < "$ENV_FILE"

echo "Deploying with ${#env_args[@]} environment variable(s) from $ENV_FILE"
exec .venv/bin/agentcore deploy -a ota_travel_agent -auc "${env_args[@]}" "$@"
