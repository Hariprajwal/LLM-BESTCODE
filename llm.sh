#!/bin/bash

echo "Starting Ollama model in background..."
/mnt/c/Users/harip/AppData/Local/Programs/Ollama/ollama.exe run codellama &

sleep 3

echo "Starting Node.js llm.js..."
# Use WSL Node.js instead of Windows Node.js for WSL files
node /mnt/d/downloads/SmartCodeHub1/SmartCodeHub/smart-code-hub-backend/llm.js &

sleep 2

echo "Opening your Smart Code Hub in browser..."
# Fixed HTML path - use Windows format with forward slashes or escaped backslashes
cmd.exe /c start "D:/downloads/SmartCodeHub1/SmartCodeHub/llm.html"

echo "All services started."
