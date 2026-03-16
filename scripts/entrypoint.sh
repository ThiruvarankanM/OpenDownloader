#!/bin/sh
# Start a virtual display so Chrome can run in headful mode (avoids bot detection)
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
sleep 1

exec node server/index.js
