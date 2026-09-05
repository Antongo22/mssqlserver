#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo 'Полный сброс SQL Server: удаляются все базы, таблицы и данные этого проекта.'
docker compose down --volumes
./scripts/start.sh
echo 'Сброс завершён. SQL Server чистый; остались только системные базы.'
echo 'Для создания учебной LearningDB запустите ./scripts/check.sh'
