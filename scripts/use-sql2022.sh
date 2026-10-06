#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo 'Запускается сохранённый SQL Server 2022 с исходными данными.'
docker compose down
docker compose -f compose.yaml -f compose.sql2022.yaml up -d --build --wait --wait-timeout 300
echo 'SQL Server 2022 готов. GUI: http://localhost:3001'
