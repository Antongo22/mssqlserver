SET NOCOUNT ON;
SELECT @@VERSION AS SQLServerVersion;
SELECT SYSDATETIME() AS ServerTime, DB_NAME() AS CurrentDatabase;
SELECT name, state_desc FROM sys.databases;
GO
