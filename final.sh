#!/usr/bin/env bash
set -euo pipefail

# Navigate to project directory
cd /mnt/d/downloads/SmartCodeHub1/SmartCodeHub/smart-code-hub-backend

echo "========================================="
echo "   SmartCodeHub Backend Startup Script"
echo "========================================="
echo ""

# Step 1: Docker
echo "🐋 [1/5] Starting Docker services..."
docker-compose up -d
if [ $? -eq 0 ]; then
    echo "✅ Docker services started successfully"
else
    echo "⚠️  Docker services may have issues, continuing..."
fi
echo ""

# Step 2: MySQL
echo "🗄️  [2/5] Ensuring MySQL service is running..."
if ! pgrep mysqld > /dev/null; then
    sudo service mysql start
    echo "✅ MySQL service started"
else
    echo "✅ MySQL already running"
fi
echo ""

# Step 3: Dependencies
echo "📦 [3/5] Installing dependencies..."
npm install --silent
echo "✅ Dependencies installed"
echo ""

# Step 4: Backend Server (Run in background)
echo "🚀 [4/5] Starting backend server..."
echo "📍 Working directory: $(pwd)"

# Create a log file for the backend server
BACKEND_LOG="/tmp/backend-server.log"
echo "📝 Backend logs will be saved to: $BACKEND_LOG"

# Start the backend server in the background and redirect output to log file
if command -v nodemon > /dev/null; then
    echo "🔄 Starting with nodemon (auto-reload enabled)..."
    nohup npx nodemon server.js > "$BACKEND_LOG" 2>&1 &
    BACKEND_PID=$!
    echo "✅ Backend server started with nodemon (PID: $BACKEND_PID)"
else
    echo "🔄 Starting with node..."
    nohup node server.js > "$BACKEND_LOG" 2>&1 &
    BACKEND_PID=$!
    echo "✅ Backend server started with node (PID: $BACKEND_PID)"
fi

# Give the backend server a moment to initialize
echo "⏳ Waiting for backend server to initialize..."
sleep 3

# Check if backend is still running
if ps -p $BACKEND_PID > /dev/null; then
    echo "✅ Backend server is running successfully"
    echo "📋 To view backend logs, run: tail -f $BACKEND_LOG"
else
    echo "❌ Backend server failed to start. Check logs at: $BACKEND_LOG"
    echo "Last 10 lines of log:"
    tail -10 "$BACKEND_LOG"
    echo ""
    echo "Continuing to start LLM anyway..."
fi
echo ""

# Step 5: LLM Service (llm.js) - Start in separate terminal
echo "🤖 [5/5] Starting LLM Service in separate terminal..."

LLM_JS_PATH="/mnt/d/downloads/SmartCodeHub1/SmartCodeHub/smart-code-hub-backend/llm.js"
LLM_LOG="/tmp/llm-service.log"

echo "📍 Target file: $LLM_JS_PATH"
echo "📝 LLM logs will be saved to: $LLM_LOG"

# Check if llm.js exists
if [ -f "$LLM_JS_PATH" ]; then
    echo "✅ Found llm.js file"
    
    # Function to start LLM in different terminal emulators
    start_llm_in_terminal() {
        local project_dir="/mnt/d/downloads/SmartCodeHub1/SmartCodeHub/smart-code-hub-backend"
        
        if command -v gnome-terminal > /dev/null 2>&1; then
            echo "🖥️  Starting LLM service in new GNOME terminal..."
            gnome-terminal --title="SmartCodeHub LLM Service" -- bash -c "cd '$project_dir'; echo 'Starting LLM Service...'; if command -v nodemon > /dev/null; then npx nodemon llm.js; else node llm.js; fi; exec bash"
        elif command -v konsole > /dev/null 2>&1; then
            echo "🖥️  Starting LLM service in new Konsole..."
            konsole --title "SmartCodeHub LLM Service" -e bash -c "cd '$project_dir'; echo 'Starting LLM Service...'; if command -v nodemon > /dev/null; then npx nodemon llm.js; else node llm.js; fi; exec bash"
        elif command -v xterm > /dev/null 2>&1; then
            echo "🖥️  Starting LLM service in new xterm..."
            xterm -title "SmartCodeHub LLM Service" -e bash -c "cd '$project_dir'; echo 'Starting LLM Service...'; if command -v nodemon > /dev/null; then npx nodemon llm.js; else node llm.js; fi; exec bash"
        elif command -v terminator > /dev/null 2>&1; then
            echo "🖥️  Starting LLM service in new Terminator..."
            terminator --title="SmartCodeHub LLM Service" -e "bash -c 'cd \"$project_dir\"; echo \"Starting LLM Service...\"; if command -v nodemon > /dev/null; then npx nodemon llm.js; else node llm.js; fi; exec bash'"
        else
            echo "❌ No supported terminal emulator found. Starting LLM in background instead..."
            if command -v nodemon > /dev/null; then
                nohup npx nodemon llm.js > "$LLM_LOG" 2>&1 &
                LLM_PID=$!
                echo "✅ LLM service started with nodemon in background (PID: $LLM_PID)"
            else
                nohup node llm.js > "$LLM_LOG" 2>&1 &
                LLM_PID=$!
                echo "✅ LLM service started with node in background (PID: $LLM_PID)"
            fi
            return 1
        fi
        return 0
    }
    
    # Start LLM service in separate terminal
    if start_llm_in_terminal; then
        echo "✅ LLM service started in separate terminal"
        echo "📋 LLM service is running in a dedicated terminal window"
        LLM_PID="separate-terminal"
    else
        # If terminal start failed but we have LLM_PID from background start
        if [ -n "$LLM_PID" ]; then
            sleep 3
            if ps -p $LLM_PID > /dev/null; then
                echo "✅ LLM service is running in background (PID: $LLM_PID)"
                echo "📋 To view LLM logs, run: tail -f $LLM_LOG"
            else
                echo "❌ LLM service failed to start. Check logs at: $LLM_LOG"
                echo "Last 10 lines of log:"
                tail -10 "$LLM_LOG"
                LLM_PID=""
            fi
        fi
    fi
else
    echo "❌ llm.js file not found at: $LLM_JS_PATH"
    echo "⚠️  Please ensure llm.js exists in the smart-code-hub-backend directory"
    LLM_PID=""
fi

echo ""
echo "========================================="
echo "         All Services Status"
echo "========================================="
echo "✅ Docker containers: RUNNING"
echo "✅ MySQL: RUNNING"
echo "✅ Backend server: RUNNING (PID: $BACKEND_PID)"
if [ -n "$LLM_PID" ]; then
    if [ "$LLM_PID" = "separate-terminal" ]; then
        echo "✅ LLM service: RUNNING in separate terminal"
    elif ps -p $LLM_PID > /dev/null 2>&1; then
        echo "✅ LLM service: RUNNING (PID: $LLM_PID)"
    else
        echo "❌ LLM service: NOT RUNNING"
    fi
else
    echo "❌ LLM service: NOT RUNNING"
fi
echo ""
echo "📊 Useful commands:"
echo "   - View backend logs: tail -f $BACKEND_LOG"
if [ -n "$LLM_PID" ] && [ "$LLM_PID" != "separate-terminal" ]; then
    echo "   - View LLM logs: tail -f $LLM_LOG"
    echo "   - Stop LLM service: kill $LLM_PID"
    echo "   - Check LLM status: ps -p $LLM_PID"
elif [ "$LLM_PID" = "separate-terminal" ]; then
    echo "   - LLM service: Running in separate terminal window"
    echo "   - To stop LLM: Close the terminal window titled 'SmartCodeHub LLM Service'"
fi
echo "   - Stop backend: kill $BACKEND_PID"
echo "   - Check backend status: ps -p $BACKEND_PID"
echo ""
echo "🎯 All services started! Press Ctrl+C to exit this script."
echo "   (Note: Services will continue running in background)"
echo ""

# Function to check if LLM is running (for background process only)
check_llm_running() {
    if [ -n "$LLM_PID" ] && [ "$LLM_PID" != "separate-terminal" ]; then
        ps -p $LLM_PID > /dev/null 2>&1
        return $?
    fi
    return 0  # If separate terminal, we can't easily check, so return true
}

# Optional: Monitor processes (only backend for separate terminal case)
echo "📡 Monitoring backend service (Ctrl+C to exit monitor)..."
while true; do
    BACKEND_RUNNING=true
    LLM_RUNNING=true
    
    if ! ps -p $BACKEND_PID > /dev/null 2>&1; then
        if [ "$BACKEND_RUNNING" = true ]; then
            echo "⚠️  Backend server stopped! Check logs at: $BACKEND_LOG"
            echo "Last 20 lines of log:"
            tail -20 "$BACKEND_LOG"
            BACKEND_RUNNING=false
        fi
    fi
    
    # Only check LLM if it's running in background (not separate terminal)
    if [ "$LLM_PID" != "separate-terminal" ] && [ -n "$LLM_PID" ] && ! check_llm_running; then
        if [ "$LLM_RUNNING" = true ]; then
            echo "⚠️  LLM service stopped! Check logs at: $LLM_LOG"
            echo "Last 20 lines of log:"
            tail -20 "$LLM_LOG"
            LLM_RUNNING=false
        fi
    fi
    
    if [ "$BACKEND_RUNNING" = false ]; then
        echo "❌ Backend service has stopped"
        break
    fi
    
    sleep 30
done
