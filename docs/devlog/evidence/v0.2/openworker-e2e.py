"""Drive Nexar through OpenWorker's own MCP client code (coworker.mcp, OpenWorker v0.3.0)."""
import asyncio, json, os, time
from coworker.mcp.config import load_mcp_servers
from coworker.mcp.client import MCPManager
from coworker.mcp.tools import tool_name


def show(label, result):
    text = result if isinstance(result, str) else json.dumps(result)
    print(f"== {label}: {text[:1500]}")
    try:
        return json.loads(result if isinstance(result, str) else json.dumps(result))
    except Exception:
        return None


def parse(result):
    # OpenWorker returns the forwarded text content; extract the JSON payload.
    raw = result if isinstance(result, str) else json.dumps(result)
    if not isinstance(result, str):
        print("  (non-text result from OpenWorker client):", raw[:400])
    start = raw.find("{")
    return json.loads(raw[start:]) if start >= 0 else {}


async def main():
    servers = load_mcp_servers(None)
    s = next(x for x in servers if x.name == "nexar")
    print("openworker names:", [tool_name(s.name, t) for t in ("nexar.submit_work", "nexar.route")])
    m = MCPManager()
    conn = await m.ensure(s)
    print("tools:", sorted(t.name for t in conn.tools))
    print("resources ->", str(await m.call(s.name, "nexar.resources", {}))[:600])
    route = await m.call(s.name, "nexar.route", {"project": "acme-demo", "taskKind": "documentation"})
    print("route ->", str(route)[:900])
    # Negative checks through the same real client.
    denied = await m.call(s.name, "nexar.route", {"project": "other-project", "taskKind": "documentation"})
    print("route (unscoped project) ->", str(denied)[:300])
    rid = f"ow-e2e-{int(time.time())}"
    if os.environ.get("E2E_MODE") == "workflow":
        req = {"requestId": rid, "project": "acme-demo",
               "workflow": {"id": os.environ.get("E2E_WORKFLOW", "sow"),
                            "inputs": json.loads(os.environ.get("E2E_INPUTS", "{}"))},
               "waitSeconds": 90}
    else:
        req = {"requestId": rid, "project": "acme-demo", "taskKind": "documentation",
               "request": "Using docs/overview.md in the working directory, write a one-page project summary in Markdown with sections Goal, Scope, Constraints, Risks. Do not modify files.",
               "documentSets": ["brief"],
               "output": {"filename": "project-summary.md", "mediaType": "text/markdown"},
               "waitSeconds": 90}
    out = parse(await m.call(s.name, "nexar.submit_work", req))
    print("submit ->", json.dumps({k: out.get(k) for k in ("status", "taskId", "error")}))
    deadline = time.time() + 600
    while out.get("status") == "running" and time.time() < deadline:
        await asyncio.sleep(10)
        out = parse(await m.call(s.name, "nexar.work_status", {"requestId": rid}))
        print("status ->", out.get("status"))
    print("FINAL:", json.dumps({k: out.get(k) for k in ("status", "taskId", "artifacts", "usage", "error")}, indent=1)[:3000])
    print("ROUTE EXPLANATION:\n", (out.get("route") or {}).get("explanation"))
    print("OUTPUT (first 1200 chars):\n", ((out.get("output") or {}).get("text") or "")[:1200])
    await m.aclose()


asyncio.run(main())
