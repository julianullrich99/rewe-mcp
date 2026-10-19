#!/bin/sh
# Virtueller Bildschirm, Fenstermanager, VNC (nur intern) und noVNC (Port 6080), dann der MCP-Server.
set -e
: "${REWE_VNC_PASSWORD:?REWE_VNC_PASSWORD fehlt}"

rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
sleep 1
fluxbox >/dev/null 2>&1 &

mkdir -p "$HOME/.vnc"
x11vnc -storepasswd "$REWE_VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null
x11vnc -display :99 -rfbauth "$HOME/.vnc/passwd" -localhost -forever -shared -rfbport 5900 -quiet >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

exec node http-server.js
