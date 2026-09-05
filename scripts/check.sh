#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo '1. Подключение и версия SQL Server'
./scripts/sql.sh < sql/01-check.sql
echo '2. Создание учебной базы и проверка INSERT / SELECT / UPDATE / DELETE'
./scripts/sql.sh < sql/02-demo.sql
echo 'OK: все проверки пройдены.'
