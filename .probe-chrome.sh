#!/bin/sh
# 起一个只装了本扩展的调试 Chrome。**每次改完 src/background/** 都要先 rm -rf profile**
# —— profile 里 Service Worker/ScriptCache 会继续喂旧的 background.js（见记忆与 §12.2）。
cd "$(dirname "$0")" || exit 1
PROFILE=".probe-profile-6"
PORT=9333
"chrome/win64-153.0.8010.36/chrome-win64/chrome.exe" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$(pwd)/$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-extensions-except="$(pwd)/dist" \
  --load-extension="$(pwd)/dist" \
  about:blank &
