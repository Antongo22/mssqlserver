#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo 'Полный сброс SQL Server: удаляются все базы, таблицы и данные этого проекта.'
docker compose down
docker volume rm mssqlserver_mssql_data
./scripts/start.sh
echo 'Сброс завершён. SQL Server чистый; остались только системные базы.'
echo 'Резервные копии сохранены в отдельном томе mssqlserver_backups.'
echo 'Для создания учебной LearningDB запустите ./scripts/check.sh'
