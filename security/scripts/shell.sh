#!/usr/bin/env bash
# Open an interactive shell inside the audit container. Run from the repo root.
exec docker compose -f security/docker-compose.yml exec audit bash
