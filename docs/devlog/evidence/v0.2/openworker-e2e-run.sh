#!/usr/bin/env bash
# OpenWorker (real MCPManager from the v0.3.0 install) -> Nexar stdio MCP -> live resource.
# Usage: run.sh <nexar-checkout> <mode: raw|workflow>
set -euo pipefail
NEXAR="$1"; MODE="${2:-raw}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HERE/run-$MODE-$(date +%s)"
mkdir -p "$RUN/home/.config/coworker" "$RUN/project/docs"
# Synthetic, non-sensitive project content.
cat > "$RUN/project/docs/overview.md" <<'EOF'
# Acme Field Ops (synthetic)
Acme wants a mobile app for field technicians to log equipment inspections offline and sync later.
Constraints: 3-month timeline, iOS + Android, existing REST backend, SSO via Azure AD.
EOF
cat > "$RUN/nexar.config.json" <<EOF
{
  "version": 1,
  "resources": [
    {
      "id": "claude-code",
      "displayName": "Claude Code",
      "kind": { "type": "agent", "agent": "claude-code", "interface": "cli", "underlying": { "provider": "anthropic" } },
      "capabilities": ["text-generation", "reasoning", "knowledge-work", "coding", "repo-editing", "code-review", "tool-use", "long-context"],
      "runtime": { "adapter": "claude-code", "locality": "local", "options": { "permissionMode": "plan", "maxTurns": 6, "timeoutMs": 240000 } },
      "auth": { "mode": "subscription", "credential": { "source": "runtime-managed", "description": "Claude Code login" } },
      "cost": { "model": "subscription" },
      "dataLocality": "third-party",
      "tags": ["native-agent"]
    }
  ],
  "routing": { "policy": "deterministic", "defaultResourceId": "claude-code" },
  "projects": [
    {
      "id": "acme-demo",
      "displayName": "Acme Field Ops (synthetic)",
      "roots": ["./project"],
      "documentSets": { "brief": ["./project/docs/overview.md"] }
    }
  ],
  "telemetry": { "jsonlPath": ".nexar/telemetry.jsonl" }
}
EOF
TOOLS="nexar.submit_work,nexar.work_status,nexar.route,nexar.resources"
[ "$MODE" = workflow ] && TOOLS="$TOOLS,nexar.workflows"
CLI=(node "$NEXAR/apps/cli/dist/main.js" --config "$RUN/nexar.config.json")
TOKEN="$("${CLI[@]}" clients add openworker \
  --tools "$TOOLS" \
  --task-kinds documentation,meeting-preparation,analysis \
  --projects acme-demo --workflows '*' 2>/dev/null)"
# OpenWorker's global MCP config (isolated HOME). The token is referenced, not inlined.
cat > "$RUN/home/.config/coworker/mcp.json" <<EOF
{ "mcpServers": { "nexar": {
  "command": "$(command -v node)",
  "args": ["$NEXAR/apps/cli/dist/main.js", "--config", "$RUN/nexar.config.json", "mcp", "serve"],
  "env": { "NEXAR_CLIENT_TOKEN": "\${NEXAR_CLIENT_TOKEN}" },
  "cwd": "$RUN",
  "requires_approval": true
} } }
EOF
export HOME="$RUN/home" NEXAR_CLIENT_TOKEN="$TOKEN" E2E_MODE="$MODE"
cd "$RUN"
"${OW_PYTHON:?set OW_PYTHON to an OpenWorker v0.3.0 venv python}" "$HERE/e2e.py"
echo "--- audit.jsonl ---"; cat "$RUN/.nexar/audit.jsonl"
echo "--- artifacts ---"; find "$RUN/project/.nexar" -type f -printf '%m %s %p\n' | sort
echo "RUN_DIR=$RUN"
