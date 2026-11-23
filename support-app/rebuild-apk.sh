#!/usr/bin/env bash
# Rebuilds the Support Desk APK. Works around Windows traps:
# - Cyrillic project path        -> builds from an ASCII copy
# - cap sync strips server.url   -> bundled launcher page carries the URL
# Version comes from support-app/VERSION: shown in the launcher name
# ("Support Desk vX.Y.Z") and as Android versionName/versionCode.
# Usage:  VERSION=1.0.2 CAPACITOR_SERVER_URL=https://site/staff ./rebuild-apk.sh
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)"
URL="${CAPACITOR_SERVER_URL:-https://pft-app-prod.vercel.app/staff}"
export CAPACITOR_SERVER_URL="$URL"
STAGE="/c/Users/User/.pft-support-build"
VERSION_FILE="$APP/VERSION"
[ -f "$VERSION_FILE" ] || echo "1.0.0" > "$VERSION_FILE"
VERSION="${VERSION:-$(cat "$VERSION_FILE")}"
VERSION_CODE="$(node -e "const p='$VERSION'.split('.').map(Number);console.log((p[0]||0)*10000+(p[1]||0)*100+(p[2]||0))")"
echo "$VERSION" > "$VERSION_FILE"
export APP_VERSION="$VERSION" APP_VERSION_CODE="$VERSION_CODE"

rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -r "$APP" "$STAGE/app"

# Fresh config, launcher page and labels with URL + version.
node -e '
const fs = require("fs");
const root = process.argv[1], url = process.env.CAPACITOR_SERVER_URL, version = process.env.APP_VERSION;
const cfg = JSON.parse(fs.readFileSync(root + "/capacitor.config.json", "utf8"));
const host = new URL(url).hostname;
cfg.appName = "Support Desk v" + version;
cfg.server.url = url;
cfg.server.allowNavigation = [host]; // WebView may navigate the deployed host after the launcher redirect
fs.writeFileSync(root + "/capacitor.config.json", JSON.stringify(cfg, null, 2));
fs.writeFileSync(root + "/www/index.html",
`<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Support Desk v${version}</title></head>
<body><p>Завантаження…</p><script>location.replace(${JSON.stringify(url)})</script></body></html>
`);
const strings = root + "/android/app/src/main/res/values/strings.xml";
fs.writeFileSync(strings, fs.readFileSync(strings, "utf8")
  .replace("Support Desk", "Support Desk v" + version));
const gradle = root + "/android/app/build.gradle";
fs.writeFileSync(gradle, fs.readFileSync(gradle, "utf8")
  .replace("versionCode 1", "versionCode " + process.env.APP_VERSION_CODE)
  .replace(/versionName "[^"]*"/, `versionName "${version}"`));
' "$STAGE/app"

export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
cd "$STAGE/app"
npx cap sync android
# cap sync drops server.url from the generated android asset config; re-inject it,
# so the WebView loads the deployed site directly (no launcher redirect hop).
node -e '
const fs = require("fs");
const p = "android/app/src/main/assets/capacitor.config.json";
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.server = cfg.server || {};
cfg.server.url = process.env.CAPACITOR_SERVER_URL;
cfg.server.androidScheme = "https";
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
'
cd "$STAGE/app/android"
./gradlew assembleDebug --no-daemon -q
mkdir -p "$APP/dist"
cp app/build/outputs/apk/debug/app-debug.apk "$APP/dist/SupportDesk-v$VERSION-debug.apk"
echo "APK: dist/SupportDesk-v$VERSION-debug.apk (opens $URL, version $VERSION / code $VERSION_CODE)"
