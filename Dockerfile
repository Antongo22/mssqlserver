FROM mcr.microsoft.com/mssql/server:2022-latest

# SQL-скрипты для ручной проверки внутри контейнера.
# Образ SQL Server не запускает их автоматически.
COPY --chown=mssql:root sql/ /usr/src/sql/

EXPOSE 1433
