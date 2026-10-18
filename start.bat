@echo off
cd /d "%~dp0"
node --experimental-sqlite server.js
if errorlevel 1 pause
