#!/bin/sh
set -eu
cd "$HOME/buddyrelay-portal"
exec 9>supervisor.lock
flock -n 9 || exit 0
mkdir -p data
chmod 700 data
if [ ! -s data/account-service.key ]; then
  /opt/alt/alt-nodejs24/root/usr/bin/node -e 'require("node:fs").writeFileSync("data/account-service.key",require("node:crypto").randomBytes(32).toString("hex"),{mode:0o600})'
fi
export PORTAL_HOST=127.0.0.1 PORTAL_PORT=18787 PORTAL_SECURE_COOKIE=1
export PORTAL_SOCKET="$HOME/buddyrelay-portal/data/portal.sock"
export PORTAL_SOCKET_DIR="$HOME/buddyrelay-portal/data"
export WB_SWITCH_SOCKET_DIR="$PORTAL_SOCKET_DIR"
export PORTAL_DATA="$HOME/buddyrelay-portal/data"
export PORTAL_ACCOUNT_TOKEN="$(cat data/account-service.key)"
export WB_SWITCH_TOKEN="$PORTAL_ACCOUNT_TOKEN"
export WB_SWITCH_HOME_OVERRIDE="$HOME/buddyrelay-portal/workbuddy-data"
export WB_SWITCH_PORT=57890 WB_SWITCH_HOST=127.0.0.1 TZ=Asia/Shanghai
while true; do
  if [ -x bin/wb-switch ] && { [ ! -f data/accounts.pid ] || ! kill -0 "$(cat data/accounts.pid)" 2>/dev/null; }; then
    bin/wb-switch serve --no-open >>data/accounts.log 2>&1 9>&- &
    echo $! > data/accounts.pid
  fi
  if [ ! -f data/portal.pid ] || ! kill -0 "$(cat data/portal.pid)" 2>/dev/null; then
    /opt/alt/alt-nodejs24/root/usr/bin/node server.mjs >>data/portal.log 2>&1 9>&- &
    echo $! > data/portal.pid
  fi
  sleep 15
done
