# SQL Server в Docker

Учебный SQL Server 2022 Developer. Нужны запущенный Docker Desktop и Docker Compose.
На Apple Silicon используется `linux/amd64` через эмуляцию. Microsoft официально
не поддерживает этот режим: https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker?view=sql-server-ver17
Developer предназначен для разработки и тестирования.

## Запуск и проверка

```bash
./scripts/start.sh
./scripts/check.sh
```

Compose собирает локальный образ из `Dockerfile` в текущей директории.
SQL-файлы также копируются в контейнер в `/usr/src/sql/`.
После изменения Dockerfile или SQL-файлов пересоберите образ: `docker compose up -d --build --wait`.

При первом запуске скрипт создаёт `.env` со случайным паролем `sa`, скачивает образ
и ждёт готовности сервера. Проверка показывает версию, создаёт `LearningDB` и таблицу
`dbo.Students`, проверяет добавление, чтение, изменение и удаление записи.
Тестовые изменения откатываются; существующие записи сохраняются.

## Свои запросы

```bash
./scripts/sql.sh -Q "SELECT @@VERSION"
./scripts/sql.sh -d LearningDB -Q "SELECT * FROM dbo.Students"
./scripts/sql.sh < sql/02-demo.sql
```

SQL-файлы можно открыть и выполнить в любом клиенте SQL Server.

## Подключение из клиента

- Сервер: `localhost,1433` (в клиентах с отдельным полем порта: `localhost`, порт `1433`).
- Аутентификация: SQL Server, пользователь `sa`.
- Пароль: значение `MSSQL_SA_PASSWORD` из локального `.env`.
- База: `LearningDB` после запуска проверки, либо `master`.
- Включить доверие сертификату сервера (`Trust server certificate`).

Порт доступен только на этом компьютере. `.env` исключён из Git.
Чтобы выбрать другой порт, измените `MSSQL_PORT` в `.env` и повторите запуск.
Изменение пароля в `.env` не меняет пароль в уже созданной базе данных.

## Управление

```bash
docker compose ps
docker compose logs --tail 100 mssql
./scripts/stop.sh
./scripts/start.sh
```

Данные находятся в именованном Docker volume и сохраняются после остановки.
Команда `docker compose down -v` удаляет volume вместе со всеми базами — используйте
её только если хотите полностью сбросить учебный сервер.

Если сервер не запускается на Apple Silicon, проверьте поддержку эмуляции amd64
в настройках Docker Desktop и выделение достаточной памяти (не менее 4 ГБ).
