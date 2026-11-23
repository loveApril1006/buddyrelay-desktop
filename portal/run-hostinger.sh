#!/bin/sh
set -eu
cd "$HOME/buddyrelay-portal"
mkdir -p data
chmod 700 data
if [ "${1:-}" = "--ensure" ]; then
  if flock -n supervisor.lock true; then
    /usr/bin/setsid -f /bin/sh "$PWD/run-hostinger.sh" </dev/null >>data/supervisor.log 2>&1
  fi
  exit 0
fi

exec 9>supervisor.lock
flock -n 9 || exit 0
if [ ! -s data/account-service.key ]; then
  /opt/alt/alt-nodejs24/root/usr/bin/node -e 'require("node:fs").writeFileSync("data/account-service.key",require("node:crypto").randomBytes(32).toString("hex"),{mode:0o600})'
fi
export PORTAL_HOST=127.0.0.1 PORTAL_PORT=18787 PORTAL_SECURE_COOKIE=1
export PORTAL_HOSTINGER_SUPERVISOR=1
export PORTAL_SOCKET="$HOME/buddyrelay-portal/data/portal.sock"
export PORTAL_SOCKET_DIR="$HOME/buddyrelay-portal/data"
export WB_SWITCH_SOCKET_DIR="$PORTAL_SOCKET_DIR"
export PORTAL_DATA="$HOME/buddyrelay-portal/data"
export PORTAL_ACCOUNT_TOKEN="$(cat data/account-service.key)"
export WB_SWITCH_TOKEN="$PORTAL_ACCOUNT_TOKEN"
export WB_SWITCH_HOME_OVERRIDE="$HOME/buddyrelay-portal/workbuddy-data"
export WB_SWITCH_PORT=57890 WB_SWITCH_HOST=127.0.0.1 TZ=Asia/Shanghai
is_running() {
  [ -r "data/$1.pid" ] || return 1
  pid=$(cat "data/$1.pid")
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$(readlink "/proc/$pid/cwd")" = "$PWD" ] &&
    [ "$(readlink "/proc/$pid/exe")" = "$2" ]
}

node_path=/opt/alt/alt-nodejs24/root/usr/bin/node
node_exe=$(readlink -f "$node_path")
accounts_exe=$(readlink -f bin/wb-switch || true)
while true; do
  if [ -x bin/wb-switch ] && ! is_running accounts "$accounts_exe"; then
    bin/wb-switch serve --no-open >>data/accounts.log 2>&1 9>&- &
    echo $! > data/accounts.pid
  fi
  if ! is_running portal "$node_exe"; then
    "$node_path" server.mjs >>data/portal.log 2>&1 9>&- &
    echo $! > data/portal.pid
  fi
  sleep 5 9>&-
done
