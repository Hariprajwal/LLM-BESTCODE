@echo off
echo Starting Ollama model in background...
start "" /B ollama run codellama

timeout /t 3 >nul
echo Starting Nodejs server...
start "" /B cmd /k "node llm.js"

timeout /t 2 >nul
echo Opening your Smart Code Hub in browser...
start "" llm.html

REM "uvicorn main:app --reload"
