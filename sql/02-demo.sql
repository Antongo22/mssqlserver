-- Можно запускать повторно: учебные данные не накапливаются.
USE master;
GO
IF DB_ID(N'LearningDB') IS NULL
    EXEC(N'CREATE DATABASE LearningDB');
GO
USE LearningDB;
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.Students', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Students (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(100) NOT NULL,
        Grade INT NOT NULL CHECK (Grade BETWEEN 1 AND 5)
    );
END;

-- Транзакция откатывается после проверки, таблица остаётся для практики.
BEGIN TRANSACTION;
INSERT INTO dbo.Students (Name, Grade) VALUES (N'Анна', 4);
DECLARE @StudentId INT = CONVERT(INT, SCOPE_IDENTITY());

SELECT * FROM dbo.Students WHERE Id = @StudentId;
IF NOT EXISTS (SELECT 1 FROM dbo.Students WHERE Id = @StudentId AND Grade = 4)
    THROW 50001, 'INSERT / SELECT failed', 1;

UPDATE dbo.Students SET Grade = 5 WHERE Id = @StudentId;
IF NOT EXISTS (SELECT 1 FROM dbo.Students WHERE Id = @StudentId AND Grade = 5)
    THROW 50002, 'UPDATE failed', 1;

DELETE FROM dbo.Students WHERE Id = @StudentId;
IF EXISTS (SELECT 1 FROM dbo.Students WHERE Id = @StudentId)
    THROW 50003, 'DELETE failed', 1;

ROLLBACK TRANSACTION;
PRINT 'OK: INSERT, SELECT, UPDATE, DELETE';
GO
