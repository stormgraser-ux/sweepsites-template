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
echo "=== Setup Complete ==="
echo ""
echo "Start the dashboard:"
echo "  npm start"
echo ""
echo "Then open: http://localhost:3050"
echo ""
echo "To run a collector:"
echo "  node automation/collectors/your-site.js --dry-run"
echo ""
echo "See README.md for full documentation."
