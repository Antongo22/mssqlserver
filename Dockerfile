FROM mcr.microsoft.com/mssql/server:2022-latest

# SQL-скрипты для ручной проверки внутри контейнера.
# Образ SQL Server не запускает их автоматически.
COPY --chown=mssql:root sql/ /usr/src/sql/

USER root
RUN mkdir -p /var/opt/mssql/backups && chown mssql:root /var/opt/mssql/backups && chmod 2770 /var/opt/mssql/backups
USER mssql

EXPOSE 1433
