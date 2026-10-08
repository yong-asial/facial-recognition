#!/usr/bin/env bash
# Run the attendance app on an Android emulator with the Mac webcam as the camera.
# Usage: scripts/android-emulator.sh [AVD_NAME]      (default: Pixel_Tablet_API_34)
#   WEBCAM=webcam0  PORT=3009  GPU=host  scripts/android-emulator.sh
#
# Why `adb reverse` + localhost: Chrome only allows the camera on HTTPS or localhost.
# http://10.0.2.2:3009 (the emulator's alias for the Mac) is NOT a secure context, so the camera would be blocked.
set -euo pipefail

AVD="${1:-Pixel_Tablet_API_34}"
PORT="${PORT:-3009}"
WEBCAM="${WEBCAM:-webcam0}"
# Software GL: with the default host GPU mode, Chrome in the emulator crashed (SIGSEGV in CompositorGpuThread).
GPU="${GPU:-swiftshader_indirect}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
EMU="$SDK/emulator/emulator"; ADB="$SDK/platform-tools/adb"
cd "$(dirname "$0")/.."

[ -x "$EMU" ] || { echo "Android emulator not found at $EMU"; exit 1; }
"$EMU" -list-avds | grep -qx "$AVD" || { echo "AVD '$AVD' not found. Available:"; "$EMU" -list-avds; exit 1; }
"$EMU" -webcam-list | grep -q "'$WEBCAM'" || { echo "Mac webcam '$WEBCAM' not found:"; "$EMU" -webcam-list; exit 1; }

# 1. App server (started here only if nothing is listening yet)
STARTED_SERVER=""
if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PORT="$PORT" node server.js >/tmp/face-attendance-server.log 2>&1 &
  STARTED_SERVER=$!
  until curl -sf "http://localhost:$PORT/api/config" >/dev/null; do sleep 0.5; done
  echo "server started on :$PORT (log: /tmp/face-attendance-server.log)"
fi
cleanup() { [ -n "$STARTED_SERVER" ] && kill "$STARTED_SERVER" 2>/dev/null || true; }
trap cleanup EXIT

# 2. Emulator with the Mac webcam as both cameras (skipped if one is already running)
if ! "$ADB" devices | grep -q "emulator-.*device$"; then
  "$EMU" -avd "$AVD" -camera-front "$WEBCAM" -camera-back "$WEBCAM" -gpu "$GPU" -no-snapshot-save >/tmp/face-attendance-emulator.log 2>&1 &
  echo "booting $AVD (log: /tmp/face-attendance-emulator.log)..."
fi
"$ADB" wait-for-device
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
echo "emulator booted"

# 3. Make the Mac's server reachable as localhost inside the emulator, pre-grant Chrome's camera permission, open the app
"$ADB" reverse tcp:"$PORT" tcp:"$PORT"
"$ADB" shell pm grant com.android.chrome android.permission.CAMERA 2>/dev/null || true
"$ADB" shell am start -a android.intent.action.VIEW -d "http://localhost:$PORT" com.android.chrome >/dev/null
echo
echo "Opened http://localhost:$PORT in the emulator's Chrome."
echo "Allow the camera when asked. Tip: hold a photo of an enrolled student up to the Mac webcam, or sit in front of it."
echo "Ctrl+C stops the server this script started (the emulator keeps running)."
[ -n "$STARTED_SERVER" ] && wait "$STARTED_SERVER"
