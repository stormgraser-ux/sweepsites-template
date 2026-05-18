#!/usr/bin/env bash
set -euo pipefail

echo "=== Sweepsites Setup ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required (v18+). Install it first:"
  echo "  https://nodejs.org/ or: nvm install 20"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required, found $(node -v)"
  exit 1
fi

echo "[1/4] Installing dependencies..."
npm install

echo ""
echo "[2/4] Installing Playwright browsers..."
npx playwright install chromium

echo ""
echo "[3/4] Running database migrations..."
node server/migrate.js

echo ""
echo "[4/4] Seeding sample data..."
node server/seed.js

echo ""
echo "[5/5] Starting dashboard..."

# Kill anything already on port 3050
if command -v lsof &>/dev/null; then
  PID=$(lsof -ti :3050 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "  Killing existing process on port 3050 (PID $PID)..."
    kill "$PID" 2>/dev/null || true
    sleep 1
  fi
elif command -v fuser &>/dev/null; then
  fuser -k 3050/tcp 2>/dev/null || true
  sleep 1
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Dashboard: http://localhost:3050"
echo ""

npm start
