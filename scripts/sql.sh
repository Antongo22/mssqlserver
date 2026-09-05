#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Пароль берётся внутри контейнера и не передаётся аргументом sqlcmd.
docker compose exec -T mssql bash -c \
  'export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"; exec /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -b -r 1 -l 10 "$@"' \
  -- "$@"
