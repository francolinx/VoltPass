#!/usr/bin/env bash
# Build + publish the VoltPass module to the local SpacetimeDB instance,
# then regenerate the TypeScript client bindings.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="${VOLTPASS_MODULE:-voltpass}"

cd "$ROOT"

# Point the CLI at the local server and clear any stale auth token whose
# signature won't match a freshly-generated local keypair.
spacetime server set-default local 2>/dev/null || \
  spacetime server add --url http://127.0.0.1:3000 local 2>/dev/null || true

echo "Publishing module '$MODULE' ..."
spacetime publish --server local "$MODULE" --project-path server -y

echo "Regenerating TypeScript bindings ..."
spacetime generate --lang typescript \
  --out-dir client/src/module_bindings \
  --project-path server

echo "Done. The module is seeded automatically on publish (init reducer)."
