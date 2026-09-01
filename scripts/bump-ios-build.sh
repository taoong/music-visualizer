#!/usr/bin/env bash
# Increments the iOS CURRENT_PROJECT_VERSION (build number) by 1.
# Run this before each Archive/upload to TestFlight — Apple requires
# a strictly higher build number than the last upload for the same
# MARKETING_VERSION.
set -euo pipefail

cd "$(dirname "$0")/../ios/App"
xcrun agvtool next-version -all
echo "iOS build number bumped to $(xcrun agvtool what-version -terse)"
