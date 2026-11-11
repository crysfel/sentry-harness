#!/bin/zsh
# Install sentry-harness as two LaunchAgents (web + worker) for the CURRENT user.
# Run it inside the dedicated, non-admin harness account (see ops/SETUP.md), from the repo root:
#   ./ops/install.sh            install or update and (re)start both agents
#   ./ops/install.sh uninstall  stop and remove both agents
#
# LaunchAgents (not LaunchDaemons): simulators and the keychain need the GUI session.
# launchd does not read your shell profile, so PATH is written into the plists here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LABEL_WEB="dev.sentry-harness.web"
LABEL_WORKER="dev.sentry-harness.worker"
PORT="${PORT:-3100}"
UID_NUM="$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  for l in $LABEL_WEB $LABEL_WORKER; do
    launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
    rm -f "$AGENTS/$l.plist"
  done
  echo "Removed $LABEL_WEB and $LABEL_WORKER."
  exit 0
fi

# Resolve tools the way the interactive shell sees them, then freeze PATH into the plists.
NODE_BIN="$(command -v node)"   || { echo "node not found on PATH"; exit 1; }
NPM_BIN="$(command -v npm)"     || { echo "npm not found on PATH"; exit 1; }
CLAUDE_BIN="$(command -v claude)" || { echo "claude not found on PATH"; exit 1; }
GH_BIN="$(command -v gh)"       || { echo "gh not found on PATH"; exit 1; }
PATH_VALUE="$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):$(dirname "$GH_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

[[ -f "$ROOT/.env" ]] || { echo "Missing $ROOT/.env (copy .env.example and fill it in)"; exit 1; }
chmod 600 "$ROOT/.env"
if grep -q '^ANTHROPIC_API_KEY=.\+' "$ROOT/.env"; then
  echo "ANTHROPIC_API_KEY is set in .env: remove it, or agent runs will bill the API instead of the subscription."; exit 1
fi

mkdir -p "$ROOT/data/logs" "$AGENTS"
cd "$ROOT"
"$NPM_BIN" ci
"$NPM_BIN" run db:migrate
"$NPM_BIN" run build

render() { # template label
  sed -e "s#__ROOT__#$ROOT#g" -e "s#__PATH__#$PATH_VALUE#g" -e "s#__NODE__#$NODE_BIN#g" \
      -e "s#__CLAUDE__#$CLAUDE_BIN#g" -e "s#__PORT__#$PORT#g" -e "s#__HOME__#$HOME#g" \
      "$ROOT/ops/$1.plist.template" > "$AGENTS/$2.plist"
  plutil -lint "$AGENTS/$2.plist" >/dev/null
}
render web "$LABEL_WEB"
render worker "$LABEL_WORKER"

for l in $LABEL_WEB $LABEL_WORKER; do
  launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$l.plist"
  launchctl enable "gui/$UID_NUM/$l"
done

# Log rotation via newsyslog (needs sudo once; the harness account is non-admin, so an admin runs it).
CONF="$ROOT/ops/newsyslog.conf"
sed -e "s#__ROOT__#$ROOT#g" -e "s#__USER__#$(id -un)#g" "$ROOT/ops/newsyslog.conf.template" > "$CONF"
echo
echo "Installed. Dashboard: http://127.0.0.1:$PORT  ·  logs: $ROOT/data/logs/"
echo "Log rotation: ask an admin to run once:  sudo cp $CONF /etc/newsyslog.d/sentry-harness.conf"
