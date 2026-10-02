#!/bin/bash
set -euo pipefail
# Credentials, bridge capabilities, logs and temporary archives must not enter
# full-root snapshots. A failed mount is fatal, never fall back to ordinary disk.
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /run
mkdir -p /workspace
exec bun /opt/agentflare/native-workspace.mjs
