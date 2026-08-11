#!/usr/bin/env bash
# Dev convenience wrapper for a local Postgres 16 server (used because Docker
# wasn't available in the original dev environment). If you have Docker, prefer
# `docker compose up -d` with the provided docker-compose.yml instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATADIR="$ROOT_DIR/.pgdata"
PGBIN="$(brew --prefix postgresql@16 2>/dev/null || echo /opt/homebrew/opt/postgresql@16)/bin"

case "${1:-}" in
  start)
    if [ ! -d "$DATADIR" ]; then
      "$PGBIN/initdb" -D "$DATADIR" -U "$(whoami)" --auth=trust
    fi
    # Idempotent: skip start if this data dir (or anything on :5432) is already up.
    if "$PGBIN/pg_ctl" -D "$DATADIR" status >/dev/null 2>&1 || \
       "$PGBIN/pg_isready" -h localhost -p 5432 >/dev/null 2>&1; then
      echo "Postgres already running on localhost:5432"
    else
      "$PGBIN/pg_ctl" -D "$DATADIR" -l "$DATADIR/server.log" -o "-p 5432" start
    fi
    # Idempotent: only create the role/db if they don't already exist.
    "$PGBIN/psql" -h localhost -p 5432 -U "$(whoami)" -d postgres -tc \
      "SELECT 1 FROM pg_roles WHERE rolname='runfar'" | grep -q 1 || \
      "$PGBIN/psql" -h localhost -p 5432 -U "$(whoami)" -d postgres -c "CREATE ROLE runfar LOGIN PASSWORD 'runfar';"
    "$PGBIN/psql" -h localhost -p 5432 -U "$(whoami)" -d postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname='runfar'" | grep -q 1 || \
      "$PGBIN/psql" -h localhost -p 5432 -U "$(whoami)" -d postgres -c "CREATE DATABASE runfar OWNER runfar;"
    ;;
  stop)
    "$PGBIN/pg_ctl" -D "$DATADIR" stop
    ;;
  *)
    echo "Usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
