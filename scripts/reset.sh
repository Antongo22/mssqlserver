#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo 'Полный сброс SQL Server: удаляются все базы, таблицы и данные этого проекта.'
docker compose --profile legacy down
for volume in mssqlserver_mssql_data_2025 mssqlserver_mssql_data; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume"
  fi
done
./scripts/start.sh
echo 'Сброс завершён. SQL Server чистый; остались только системные базы.'
echo 'Резервные копии сохранены в отдельном томе mssqlserver_backups.'
echo 'Для создания учебной LearningDB запустите ./scripts/check.sh'
