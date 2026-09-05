#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  umask 077
  printf 'MSSQL_SA_PASSWORD=Sql_%s_aA1!\nMSSQL_PORT=1433\n' "$(openssl rand -hex 16)" > .env
  echo 'Создан .env со случайным паролем sa.'
fi

docker compose up -d --build --wait --wait-timeout 300
echo 'SQL Server готов. Проверка: ./scripts/check.sh'
