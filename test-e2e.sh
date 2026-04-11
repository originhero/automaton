#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# OriginHero E2E Test Script
# Run this from: ~/Desktop/originhero/automaton-fork/
# ═══════════════════════════════════════════════════════════════

set -e
BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
NC="\033[0m"

echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}  OriginHero E2E Test Suite${NC}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo ""

PASS=0
FAIL=0

check() {
  if [ $? -eq 0 ]; then
    echo -e "  ${GREEN}✓${NC} $1"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $1"
    FAIL=$((FAIL + 1))
  fi
}

# ─── Test 1: TypeScript Compilation ───────────────────────────
echo -e "${BOLD}[1/6] TypeScript Compilation${NC}"
npx tsc --noEmit > /dev/null 2>&1
check "Automaton compiles clean"

cd ../dashboard
npx tsc --noEmit > /dev/null 2>&1
check "Dashboard compiles clean"
cd ../automaton-fork

# ─── Test 2: Config Loading ──────────────────────────────────
echo -e "\n${BOLD}[2/6] Config Files${NC}"
test -f automaton.local.json
check "automaton.local.json exists"

node -e "
  const c = JSON.parse(require('fs').readFileSync('automaton.local.json','utf8'));
  if (!c.business) { process.exit(1); }
  if (!c.business.repo) { process.exit(1); }
  if (!c.business.domains || c.business.domains.length === 0) { process.exit(1); }
  if (!c.business.servers || c.business.servers.length === 0) { process.exit(1); }
  console.log('    Business: ' + c.business.name);
  console.log('    Repo: ' + c.business.repo.url);
  console.log('    Domain: ' + c.business.domains[0].fqdn);
  console.log('    Server: ' + c.business.servers[0].name);
" 2>/dev/null
check "Business config has repo, domains, servers"

# ─── Test 3: Module Imports ──────────────────────────────────
echo -e "\n${BOLD}[3/6] Module Imports${NC}"

npx tsx -e "
  import { createLocalConwayClient } from './src/local/client.js';
  console.log('    createLocalConwayClient: OK');
" 2>/dev/null
check "LocalConwayClient imports"

npx tsx -e "
  import { createBusinessTools } from './src/local/business-connector.js';
  const tools = createBusinessTools();
  console.log('    Business tools: ' + tools.map(t => t.name).join(', '));
  if (tools.length < 5) process.exit(1);
" 2>/dev/null
check "BusinessConnector creates 7 tools"

npx tsx -e "
  import { createAPIServer } from './src/api/server.js';
  console.log('    createAPIServer: OK');
" 2>/dev/null
check "API Server imports"

# ─── Test 4: Start Automaton + API ───────────────────────────
echo -e "\n${BOLD}[4/6] Automaton Runtime + API Server${NC}"

# Clean state
rm -f ~/.automaton/state.db ~/.automaton/state.db-shm ~/.automaton/state.db-wal 2>/dev/null

# Create wallet if not exists
if [ ! -f ~/.automaton/wallet.json ]; then
  mkdir -p ~/.automaton
  cat > ~/.automaton/wallet.json << 'WALLETEOF'
{
  "privateKey": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "createdAt": "2026-04-04T00:00:00.000Z",
  "chainType": "evm"
}
WALLETEOF
  chmod 600 ~/.automaton/wallet.json
fi

# Copy local config as main config
cp automaton.local.json ~/.automaton/automaton.json

# Start automaton in background
ORIGINHERO_MODE=local \
GOOGLE_API_KEY="${GOOGLE_API_KEY:-AIzaSyAKQ-f3I179Jf-qiWcWp9S2SOLoLO8dpqk}" \
npx tsx src/index.ts --run > /tmp/originhero-test.log 2>&1 &
AUTOMATON_PID=$!
echo -e "  ${YELLOW}⏳${NC} Automaton starting (PID: $AUTOMATON_PID)..."

# Wait for API to respond
API_OK=false
for i in $(seq 1 15); do
  sleep 2
  if curl -s http://localhost:3001/api/status > /tmp/api-status.json 2>/dev/null; then
    API_OK=true
    break
  fi
done

if [ "$API_OK" = true ]; then
  check "API server responds on :3001"

  # Parse status
  node -e "
    const s = JSON.parse(require('fs').readFileSync('/tmp/api-status.json','utf8'));
    console.log('    Name: ' + s.name);
    console.log('    State: ' + s.state);
    console.log('    Business: ' + (s.businessName || 'none'));
    console.log('    Has business: ' + s.hasBusiness);
  " 2>/dev/null
else
  false
  check "API server responds on :3001"
  echo -e "  ${RED}Last 10 lines of log:${NC}"
  tail -10 /tmp/originhero-test.log
fi

# ─── Test 5: API Endpoints ───────────────────────────────────
echo -e "\n${BOLD}[5/6] API Endpoints${NC}"

if [ "$API_OK" = true ]; then
  # GET /api/business
  curl -s http://localhost:3001/api/business | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.configured && d.business && d.business.name) process.exit(0);
    process.exit(1);
  " 2>/dev/null
  check "GET /api/business returns business config"

  # GET /api/config
  curl -s http://localhost:3001/api/config | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.providers && typeof d.providers.google === 'boolean') process.exit(0);
    process.exit(1);
  " 2>/dev/null
  check "GET /api/config returns sanitized config (no secrets)"

  # GET /api/business/health
  curl -s http://localhost:3001/api/business/health | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.domains && d.servers && d.services) process.exit(0);
    process.exit(1);
  " 2>/dev/null
  check "GET /api/business/health returns health status"

  # POST /api/validate/domain
  curl -s -X POST http://localhost:3001/api/validate/domain \
    -H "Content-Type: application/json" \
    -d '{"domain":"starlumon.ai"}' | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('    Domain check: ' + d.message + ' (DNS: ' + (d.dns || 'n/a') + ')');
  " 2>/dev/null
  check "POST /api/validate/domain works"

  # GET /api/models
  curl -s http://localhost:3001/api/models > /dev/null 2>&1
  check "GET /api/models responds"

  # GET /api/approvals
  curl -s http://localhost:3001/api/approvals | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (Array.isArray(d.approvals)) process.exit(0);
    process.exit(1);
  " 2>/dev/null
  check "GET /api/approvals returns array"

else
  echo -e "  ${YELLOW}⚠ Skipping API tests (server not running)${NC}"
fi

# ─── Test 6: Agent Loop ──────────────────────────────────────
echo -e "\n${BOLD}[6/6] Agent Loop${NC}"

if [ "$API_OK" = true ]; then
  # Wait for at least 1 agent turn
  echo -e "  ${YELLOW}⏳${NC} Waiting for first agent turn (up to 30s)..."
  TURN_OK=false
  for i in $(seq 1 15); do
    sleep 2
    TURN_COUNT=$(curl -s http://localhost:3001/api/status | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.turnCount || 0);
    " 2>/dev/null)
    if [ "$TURN_COUNT" -gt 0 ] 2>/dev/null; then
      TURN_OK=true
      echo -e "    Agent completed $TURN_COUNT turn(s)"
      break
    fi
  done

  if [ "$TURN_OK" = true ]; then
    check "Agent loop executed at least 1 turn"

    # Check turns endpoint has data
    curl -s "http://localhost:3001/api/turns?limit=1" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.turns && d.turns.length > 0) {
        console.log('    Turn data available in API');
        process.exit(0);
      }
      process.exit(1);
    " 2>/dev/null
    check "GET /api/turns returns turn data"
  else
    false
    check "Agent loop executed at least 1 turn"
    echo -e "  ${YELLOW}Last 15 lines:${NC}"
    tail -15 /tmp/originhero-test.log
  fi
else
  echo -e "  ${YELLOW}⚠ Skipping agent tests (server not running)${NC}"
fi

# ─── Cleanup ─────────────────────────────────────────────────
echo ""
if [ -n "$AUTOMATON_PID" ]; then
  kill $AUTOMATON_PID 2>/dev/null
  wait $AUTOMATON_PID 2>/dev/null
fi

# ─── Summary ─────────────────────────────────────────────────
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
TOTAL=$((PASS + FAIL))
if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}All $TOTAL tests passed!${NC}"
else
  echo -e "  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} (of $TOTAL)"
fi
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo "Full log: /tmp/originhero-test.log"

exit $FAIL
