#!/usr/bin/env bash
# Drives a local Micro Fish (society-sim) Soot workspace for Claude Code.
# The user owns soot, node and ~/.soot/config.json; this script owns the rest.
set -euo pipefail

HOME_DIR="${MICRO_FISH_HOME:-$HOME/.soot/micro-fish}"
WS="$HOME_DIR/sim"
DEPLOY="$WS/deployment.json"
PORT="${MICRO_FISH_PORT:-7801}"
AI_CONFIG="${MICRO_FISH_AI_CONFIG:-$HOME/.soot/config.json}"
PID_FILE="$HOME_DIR/serve.pid"
LOG="$HOME_DIR/serve.log"
RUNS="$HOME_DIR/runs"
RELEASE="https://github.com/2found/soot-forge/releases/latest/download"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "micro-fish: $*" >&2; exit 1; }
running() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

doctor() {
  local ok=1
  command -v soot >/dev/null || { echo "MISSING soot — install Soot first"; ok=0; }
  command -v node >/dev/null || { echo "MISSING node — Micro Fish tools run on Node.js 20+"; ok=0; }
  [[ -f "$AI_CONFIG" ]] || { echo "MISSING $AI_CONFIG — configure an AI provider and model"; ok=0; }
  if [[ $ok == 1 ]]; then
    soot version | head -1
    # The key_env of every provider the model and tiers use must be set (values never printed).
    # Providers the config declares but no model uses are not checked.
    node -e '
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const flash = c.tiers?.flash ?? c.model ?? {};
      console.log(`config ${process.argv[1]}: flash tier = ${flash.provider ?? c.model?.provider ?? "?"}/${flash.name ?? "?"}`);
      const used = new Set(), envs = new Set();
      for (const m of [c.model, ...Object.values(c.tiers ?? {})].filter(Boolean))
        for (const r of [m, ...(m.fallbacks ?? [])]) used.add(r.provider ?? c.model?.provider);
      for (const id of used) { const k = c.providers?.[id]?.key_env; if (k) envs.add(k); }
      if (c.model?.key_env) envs.add(c.model.key_env);
      let bad = 0;
      for (const e of envs) { const set = !!process.env[e]; if (!set) bad++; console.log(`${set ? "SET    " : "UNSET  "} ${e}`); }
      process.exit(bad ? 3 : 0);' "$AI_CONFIG" || { echo "An API key variable is not exported in this shell"; ok=0; }
  fi
  [[ -f "$DEPLOY" ]] && echo "workspace $WS" || echo "workspace not created (run: setup)"
  running && echo "server running pid $(cat "$PID_FILE") on 127.0.0.1:$PORT" || echo "server stopped"
  [[ $ok == 1 ]] && echo READY || { echo NOT_READY; exit 2; }
}

# setup [--from <soot-forge checkout>]: install the group template and create the workspace.
setup() {
  [[ -f "$DEPLOY" ]] && { echo "workspace exists: $WS"; return; }
  mkdir -p "$HOME_DIR" "$RUNS"
  cd "$HOME_DIR"
  local archive sha
  if [[ "${1:-}" == "--from" ]]; then
    [[ -n "${2:-}" ]] || die "--from needs a soot-forge checkout"
    sha=$(node "$HERE/build-local.mjs" "$(cd "$2" && pwd)" "$HOME_DIR/build")
    archive="./build/society-sim-group.tar.gz"
  else
    local install
    install=$(curl -fsSL "$RELEASE/groups.json" | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const g = JSON.parse(s).groups.find(g => g.id === "society-sim");
        if (!g) process.exit(4);
        console.log(g.archive.url + " " + g.archive.sha256);
      });') || die "the latest soot-forge release has no society-sim group yet; rerun with --from <soot-forge checkout>"
    read -r url sha <<<"$install"
    archive="./$(basename "$url")"
    curl -fsSL -o "$archive" "$url"
  fi
  rm -rf groups.d/society-sim
  soot group add "$archive" --sha256 "$sha" >/dev/null
  soot group create groups.d/society-sim --name sim --output "$WS" --ai-config "$AI_CONFIG" >/dev/null
  # A standard run (48 personas, two social rounds) needs more than the default budget.
  node -e '
    const fs = require("fs"), [file, port] = process.argv.slice(1);
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    d.listen = `127.0.0.1:${port}`; d.run_timeout = "45m";
    Object.assign(d.collaboration["sim-moderator"], {max_delegations: 48, max_concurrent: 8, max_model_calls: 320});
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");' "$DEPLOY" "$PORT"
  soot check --config "$DEPLOY" | tail -1
  echo "workspace created: $WS"
}

start() {
  [[ -f "$DEPLOY" ]] || die "no workspace; run setup first"
  running && { echo "server already running pid $(cat "$PID_FILE")"; return; }
  : >"$LOG"
  # Background soot itself, not a `cd && soot` list, so $! is the server's pid.
  (cd "$WS" || exit 1; nohup soot serve --config "$DEPLOY" >>"$LOG" 2>&1 & echo $! >"$PID_FILE")
  for _ in $(seq 1 60); do
    grep -q "Soot ready" "$LOG" && { head -1 "$LOG"; return; }
    running || { cat "$LOG" >&2; rm -f "$PID_FILE"; die "server exited"; }
    sleep 0.5
  done
  die "server not ready after 30s; see $LOG"
}

# ask <message-file> [conversation-id]: one run; prints the conversation id and the answer path.
ask() {
  local file="${1:?message file}" conv="${2:-}" stamp out
  running || die "server not running; run start"
  stamp=$(date +%Y%m%d-%H%M%S); out="$RUNS/$stamp"
  mkdir -p "$RUNS"
  soot run --config "$DEPLOY" --timeout "${MICRO_FISH_TIMEOUT:-40m}" --json --progress ${conv:+--conversation "$conv"} --stdin <"$file" >"$out.json" 2>"$out.progress" || true
  node -e '
    const fs = require("fs"), [json, md] = process.argv.slice(1);
    let r = {}; try { r = JSON.parse(fs.readFileSync(json, "utf8")); } catch {}
    fs.writeFileSync(md, r.text ?? "");
    console.log(`state=${r.state ?? "failed"} conversation=${r.conversation_id ?? ""} answer=${md}`);' "$out.json" "$out.md"
  echo "progress=$out.progress"
}

# tally <sim-id>: the deterministic statistics the report must match.
tally() {
  local sim="${1:?sim id}" file
  file=$(ls -t "$WS"/data/pack-state/micro-fish/worlds/*/"$sim".json 2>/dev/null | head -1 || true)
  [[ -n "$file" ]] || die "no simulation $sim"
  node --input-type=module -e '
    const [tools, dir, sim] = process.argv.slice(1);
    const { tally } = await import(tools + "/world.mjs");
    try { console.log(JSON.stringify(await tally(dir, { sim }), null, 1)); }
    catch (e) { console.error(`micro-fish: ${e.message}`); process.exit(1); }' "$WS/packs.d/micro-fish/tools" "$(dirname "$file")" "$sim"
}

sims() { ls -t "$WS"/data/pack-state/micro-fish/worlds/*/*.json 2>/dev/null | sed -E 's#.*/([^/]+)\.json#\1#' || true; }

stop() {
  local pid
  if running; then pid=$(cat "$PID_FILE")
  else
    # A server whose pid file was lost still holds the workspace; match its exact config.
    pid=$(pgrep -f "soot serve --config $DEPLOY\$" | head -1 || true)
    [[ -n "$pid" ]] || { rm -f "$PID_FILE"; echo "server stopped"; return; }
  fi
  kill "$pid"
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && die "pid $pid did not stop"
  rm -f "$PID_FILE"; echo "server stopped"
}

cmd="${1:-doctor}"; shift || true
case "$cmd" in
  doctor|setup|start|ask|tally|sims|stop) "$cmd" "$@" ;;
  *) die "usage: micro-fish.sh doctor|setup [--from dir]|start|ask <file> [conversation]|sims|tally <sim>|stop" ;;
esac
