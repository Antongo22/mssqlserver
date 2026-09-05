#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose down
echo 'SQL Server остановлен. Данные сохранены в Docker volume.'
