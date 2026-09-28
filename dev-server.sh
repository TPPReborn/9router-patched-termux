#!/data/data/com.termux/files/usr/bin/bash
#
# 9Router Production Server Manager
# Usage: ./dev-server.sh [start|stop|restart|status]
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.dev-server.pid"
LOG_FILE="$SCRIPT_DIR/.dev-server.log"
TMUX_SESSION="9router-prod"
PORT=20129

get_next_pid() {
    # Prefer the real next-server worker; fall back to the node server.js launcher.
    local pid
    pid=$(pgrep -f "next-server" | head -1)
    if [ -n "$pid" ]; then
        echo "$pid"
        return
    fi
    pgrep -f "node.*\.next/standalone/server\.js|node server\.js" | head -1
}

is_9router_daemon() {
    local pid=$1
    ps -p $pid -o cmd= 2>/dev/null | grep -q "9router\|kiro"
}

copy_static_files() {
    echo "Copying static files to standalone build..."
    cp -r .next/static .next/standalone/.next/static 2>/dev/null
    cp -r public .next/standalone/public 2>/dev/null
    echo "✓ Static files copied"
}

kill_port_processes() {
    echo "Checking for processes using port $PORT..."
    
    # Method 1: Kill all next/standalone processes
    local next_pids=$(pgrep -f "\.next/standalone/server.js")
    if [ -n "$next_pids" ]; then
        echo "Found Next.js standalone processes: $next_pids"
        echo "Killing them gracefully..."
        echo "$next_pids" | xargs kill 2>/dev/null
        sleep 2
        
        # Check if still running
        next_pids=$(pgrep -f "\.next/standalone/server.js")
        if [ -n "$next_pids" ]; then
            echo "Force killing remaining processes..."
            echo "$next_pids" | xargs kill -9 2>/dev/null
            sleep 1
        fi
    fi
    
    # Method 2: Use lsof to find port users, but exclude 9router
    local port_pids=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$port_pids" ]; then
        echo "Found processes on port $PORT: $port_pids"
        
        for pid in $port_pids; do
            if is_9router_daemon $pid; then
                echo "  PID $pid is 9Router daemon - skipping"
            else
                echo "  Killing PID $pid..."
                kill $pid 2>/dev/null
            fi
        done
        
        sleep 2
        
        # Force kill if needed (still skip 9router)
        port_pids=$(lsof -ti:$PORT 2>/dev/null)
        if [ -n "$port_pids" ]; then
            echo "Force killing remaining processes..."
            for pid in $port_pids; do
                if ! is_9router_daemon $pid; then
                    kill -9 $pid 2>/dev/null
                fi
            done
            sleep 1
        fi
    fi
    
    # Method 3: Test if port is free
    if ! timeout 1 node -e "require('net').createServer().listen($PORT).close()" 2>/dev/null; then
        echo "⚠ Warning: Port $PORT is still in use"
        
        # Show what's using it
        local remaining=$(lsof -ti:$PORT 2>/dev/null)
        if [ -n "$remaining" ]; then
            echo "  Process(es) still using port:"
            for pid in $remaining; do
                local cmd=$(ps -p $pid -o cmd= 2>/dev/null)
                if is_9router_daemon $pid; then
                    echo "    PID $pid: $cmd (9Router daemon - cannot kill)"
                    echo ""
                    echo "✗ Port $PORT is occupied by 9Router daemon"
                    echo "  Please stop the 9Router daemon first or use a different port"
                    return 1
                else
                    echo "    PID $pid: $cmd"
                fi
            done
        fi
        
        return 1
    fi
    
    echo "✓ Port $PORT is now free"
    return 0
}

start_server() {
    # Check if build exists
    if [ ! -f ".next/standalone/server.js" ]; then
        echo "✗ No standalone build found. Running build first..."
        npm run build
        if [ $? -ne 0 ]; then
            echo "✗ Build failed"
            return 1
        fi
        copy_static_files
    else
        # Check if static files need to be copied
        if [ ! -d ".next/standalone/.next/static" ] || [ ! -d ".next/standalone/public" ]; then
            copy_static_files
        fi
    fi
    
    # Check if tmux session already exists
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        echo "Tmux session '$TMUX_SESSION' already exists"
        echo "Killing it first..."
        tmux kill-session -t "$TMUX_SESSION"
        sleep 1
    fi
    
    # Always kill any existing processes first
    if ! kill_port_processes; then
        return 1
    fi
    
    echo ""
    echo "Starting 9Router production server on port $PORT (in tmux session: $TMUX_SESSION)..."

    # Start production server in detached tmux session using standalone build.
    # Export DATA_DIR (and other vars) from repo .env — Next standalone does NOT
    # auto-load dotenv; without DATA_DIR the process falls back to ~/.9router.
    cd "$SCRIPT_DIR"
    local ENV_EXPORTS=""
    if [ -f "$SCRIPT_DIR/.env" ]; then
      ENV_EXPORTS=$(grep -E '^(DATA_DIR|JWT_SECRET|INITIAL_PASSWORD|API_KEY_SECRET|MACHINE_ID_SALT|BASE_URL|CLOUD_URL|NODE_ENV|AUTH_COOKIE_SECURE|REQUIRE_API_KEY)=' "$SCRIPT_DIR/.env" \
        | sed 's/\r$//' \
        | grep -v '^#' \
        | xargs -I{} echo -n "export {}; ")
    fi
    # LOG_FILE is absolute ($SCRIPT_DIR/.dev-server.log) — do NOT prefix with ../../
    # (that produced tee: ../..//abs/path: No such file and broke start detection).
    tmux new-session -d -s "$TMUX_SESSION" "cd .next/standalone && ${ENV_EXPORTS}PORT=$PORT node server.js 2>&1 | tee \"$LOG_FILE\""
    
    # Wait for process to start
    sleep 5
    
    SERVER_PID=$(get_next_pid)
    
    if [ -n "$SERVER_PID" ]; then
        echo "$SERVER_PID" > "$PID_FILE"
        
        # Check if server is actually responding
        if grep -q "started server on\|Ready\|Listening on" "$LOG_FILE" 2>/dev/null; then
            echo "✓ Production server started successfully (PID: $SERVER_PID)"
            echo "  Local:   http://localhost:$PORT"
            LOCAL_IP=$(ifconfig 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v 127.0.0.1 | head -1)
            if [ -n "$LOCAL_IP" ]; then
                echo "  Network: http://$LOCAL_IP:$PORT"
            fi
            echo ""
            echo "View logs:     ./dev-server.sh logs"
            echo "Attach tmux:   tmux attach -t $TMUX_SESSION"
            echo "Stop:          ./dev-server.sh stop"
            return 0
        else
            # Check if there was an error
            echo "✗ Server failed to start properly"
            echo ""
            echo "Last 15 lines of log:"
            tail -15 "$LOG_FILE"
            return 1
        fi
    else
        echo "✗ Failed to start production server process"
        echo "Check logs: cat $LOG_FILE"
        echo "Or attach to tmux: tmux attach -t $TMUX_SESSION"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop_server() {
    echo "Stopping production server..."
    
    # Kill tmux session
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        echo "Killing tmux session: $TMUX_SESSION"
        tmux kill-session -t "$TMUX_SESSION"
        sleep 1
    fi
    
    # Also clean up any remaining processes
    kill_port_processes
    rm -f "$PID_FILE"
    echo "✓ Production server stopped"
}

status_server() {
    RUNNING_PID=$(get_next_pid)
    
    if [ -n "$RUNNING_PID" ]; then
        echo "✓ Production server is running (PID: $RUNNING_PID)"
        echo "  Port: $PORT"
        echo "  URL:  http://localhost:$PORT"
        
        if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
            echo "  Tmux: $TMUX_SESSION (active)"
            echo "  Attach: tmux attach -t $TMUX_SESSION"
        fi
        
        if [ -f "$LOG_FILE" ]; then
            echo "  Logs: ./dev-server.sh logs"
        fi
        
        echo "$RUNNING_PID" > "$PID_FILE"
        return 0
    else
        echo "✗ Production server is not running"
        rm -f "$PID_FILE"
        
        # Check if tmux session exists but process died
        if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
            echo "  Tmux session exists but server is not running"
            echo "  Run './dev-server.sh start' to clean up and restart"
        fi
        
        # Check if port is in use by something else
        if ! timeout 1 node -e "require('net').createServer().listen($PORT).close()" 2>/dev/null; then
            echo "⚠ Warning: Port $PORT is in use by another process"
            local pid=$(lsof -ti:$PORT 2>/dev/null | head -1)
            if [ -n "$pid" ]; then
                local cmd=$(ps -p $pid -o cmd= 2>/dev/null)
                if is_9router_daemon $pid; then
                    echo "  9Router daemon is using the port"
                else
                    echo "  Run './dev-server.sh start' to clean up and start"
                fi
            fi
        fi
        
        return 1
    fi
}

restart_server() {
    echo "Restarting production server..."
    stop_server
    sleep 2
    start_server
}

logs_server() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo "✗ Log file not found: $LOG_FILE"
        return 1
    fi
}

case "${1:-start}" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        restart_server
        ;;
    status)
        status_server
        ;;
    logs)
        logs_server
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start   - Start production server (auto-copies static files)"
        echo "  stop    - Stop the production server"
        echo "  restart - Stop + Start with full cleanup"
        echo "  status  - Check server status"
        echo "  logs    - Follow server logs"
        echo ""
        echo "Note: Always uses port 20129. Protects 9Router daemon from being killed."
        echo "      Runs standalone production server in tmux with static files."
        echo "      Attach to session: tmux attach -t $TMUX_SESSION"
        exit 1
        ;;
esac
