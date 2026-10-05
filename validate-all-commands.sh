#!/bin/bash

# Comprehensive validation script for all CLI commands
# Tests real Spotify commands to ensure no null/undefined errors
# Exit code: 0 if all tests pass, non-zero otherwise

set -e

# Color output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Real playlist IDs from user's Spotify account
TEST_PLAYLIST_ID="0FRr10mglUR3E0Pq8TqlxL"
TEST_TRACK_ID="62PaSfnXSMyLshYJrlTuL3"

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

test_command() {
  local name="$1"
  local cmd="$2"
  local expected_code="${3:-0}"

  TESTS_RUN=$((TESTS_RUN + 1))
  echo -n "Testing: $name ... "

  if eval "$cmd" > /dev/null 2>&1; then
    if [ "$expected_code" = "0" ]; then
      echo -e "${GREEN}✓ PASS${NC}"
      TESTS_PASSED=$((TESTS_PASSED + 1))
    else
      echo -e "${RED}✗ FAIL${NC} (expected exit code $expected_code)"
      TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
  else
    if [ "$expected_code" != "0" ]; then
      echo -e "${GREEN}✓ PASS${NC} (exit code as expected)"
      TESTS_PASSED=$((TESTS_PASSED + 1))
    else
      echo -e "${RED}✗ FAIL${NC}"
      TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
  fi
}

echo "================================================"
echo "Spotify CLI Comprehensive Validation Test Suite"
echo "================================================"
echo ""

# Load environment
export $(grep -v '^#' .env | xargs)

echo "Running tests..."
echo ""

# ============ SEARCH COMMANDS ============
echo -e "${YELLOW}Search Commands:${NC}"
test_command "Search tracks" "tsx --env-file .env src/cli/cli.ts search 'hello' --type track --quiet"
test_command "Search playlists" "tsx --env-file .env src/cli/cli.ts search 'mola' --type playlist --quiet"
test_command "Search albums" "tsx --env-file .env src/cli/cli.ts search 'thriller' --type album --quiet"
test_command "Search artists" "tsx --env-file .env src/cli/cli.ts search 'adele' --type artist --quiet"
test_command "Search with JSON output" "tsx --env-file .env src/cli/cli.ts search 'music' --type track --json"
echo ""

# ============ PLAYLIST COMMANDS ============
echo -e "${YELLOW}Playlist Commands:${NC}"
test_command "List playlists (all)" "tsx --env-file .env src/cli/cli.ts playlist list --quiet"
test_command "List playlists (owned)" "tsx --env-file .env src/cli/cli.ts playlist list --owned --quiet"
test_command "List playlists (followed)" "tsx --env-file .env src/cli/cli.ts playlist list --followed --quiet"
test_command "Show playlist details" "tsx --env-file .env src/cli/cli.ts playlist show $TEST_PLAYLIST_ID"
test_command "Create playlist (dry-run)" "tsx --env-file .env src/cli/cli.ts playlist create 'test-playlist' --dry-run"
test_command "Create playlist with description" "tsx --env-file .env src/cli/cli.ts playlist create 'test' --description 'Test' --dry-run"
echo ""

# ============ EXPORT COMMANDS ============
echo -e "${YELLOW}Export Commands:${NC}"
test_command "Export playlist to JSON (stdout)" "tsx --env-file .env src/cli/cli.ts export $TEST_PLAYLIST_ID --format json"
test_command "Export playlist to CSV" "tsx --env-file .env src/cli/cli.ts export $TEST_PLAYLIST_ID --format csv"
test_command "Export liked songs to JSON" "tsx --env-file .env src/cli/cli.ts export --liked --format json"
echo ""

# ============ AUTH COMMANDS ============
echo -e "${YELLOW}Auth Commands:${NC}"
test_command "Auth status" "tsx --env-file .env src/cli/cli.ts auth status"
test_command "Auth status JSON" "tsx --env-file .env src/cli/cli.ts auth status --json"
echo ""

# ============ OUTPUT MODES ============
echo -e "${YELLOW}Output Format Tests:${NC}"
test_command "JSON output" "tsx --env-file .env src/cli/cli.ts search 'test' --type track --json"
test_command "Quiet output" "tsx --env-file .env src/cli/cli.ts search 'test' --type track --quiet"
test_command "Table output (TTY test)" "tsx --env-file .env src/cli/cli.ts search 'test' --type track 2>&1"
echo ""

# ============ ERROR CASES ============
echo -e "${YELLOW}Error Handling Tests:${NC}"
test_command "Invalid type (should fail)" "tsx --env-file .env src/cli/cli.ts search 'test' --type invalid" "1"
test_command "Invalid playlist ID (should fail)" "tsx --env-file .env src/cli/cli.ts playlist show 'invalid-id'" "1"
test_command "Unknown command (should fail)" "tsx --env-file .env src/cli/cli.ts invalid-command" "2"
echo ""

# ============ SUMMARY ============
echo "================================================"
echo "Test Results"
echo "================================================"
echo "Tests run:    $TESTS_RUN"
echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
  echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
else
  echo "Tests failed: $TESTS_FAILED"
fi
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ Some tests failed${NC}"
  exit 1
fi
