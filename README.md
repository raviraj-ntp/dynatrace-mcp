# Dynatrace MCP

Local MCP server for **any Dynatrace SaaS/Grail tenant** — Kubernetes pod status, bounded log search, Davis problem triage, metrics, and security summaries. Nothing is hardcoded to a cluster, namespace, or workload; pass filters (or discover them with `list_clusters` / `list_namespaces`).

- Runs on **your machine** (stdio)
- **npm:** `@raviraj87/dynatrace-mcp`
- Replaces the hosted Dynatrace MCP gateway for agent workflows. Does **not** clone Davis Copilot NL→DQL or docs RAG.

---

## Quick start

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dynatrace": {
      "command": "npx",
      "args": ["-y", "@raviraj87/dynatrace-mcp@latest"],
      "env": {
        "DYNATRACE_URL": "https://abc12345.apps.dynatrace.com",
        "DYNATRACE_API_TOKEN": "dt0s16.your-platform-token"
      }
    }
  }
}
```

Local checkout:

```json
{
  "mcpServers": {
    "dynatrace-local": {
      "command": "node",
      "args": ["/path/to/dynatrace-mcp/dist/index.js"],
      "env": {
        "DYNATRACE_URL": "https://abc12345.apps.dynatrace.com",
        "DYNATRACE_API_TOKEN": "dt0s16.your-platform-token"
      }
    }
  }
}
```

Restart Cursor. Ask: *"Use dynatrace_health"*.

Platform token scopes should include Grail reads (`storage:logs:read`, `storage:events:read`, `storage:metrics:read`, `storage:entities:read`, `storage:buckets:read`, `storage:security.events:read`) plus problem/entity access as needed.

`DT_ENVIRONMENT` / `DT_PLATFORM_TOKEN` are accepted as aliases.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNATRACE_URL` | Yes* | `https://{env}.apps.dynatrace.com` |
| `DYNATRACE_API_TOKEN` | Yes* | Token only (`dt0s16....`). Do **not** prefix `Api-Token` — the server adds that. A pasted `Api-Token …` / `Bearer …` value is stripped. |
| `DYNATRACE_STAGE_URL` / `DYNATRACE_STAGE_TOKEN` | No | Named `stage` connection |
| `DYNATRACE_PROD_URL` / `DYNATRACE_PROD_TOKEN` | No | Named `prod` connection |
| `DYNATRACE_CONNECTIONS` | No | JSON map of extra `{ "name": { "url", "token" } }` |
| `DYNATRACE_DEFAULT_CONNECTION` | No | Default connection name |
| `DYNATRACE_GRAIL_QUERY_BUDGET_GB` | No | Session Grail scan cap (default 1000) |
| `NODE_EXTRA_CA_CERTS` | No | Corporate CA PEM |
| `DYNATRACE_NO_SSL_VERIFY` | No | Skip TLS verify (insecure) |

\*Or `DT_ENVIRONMENT` + `DT_PLATFORM_TOKEN`.

Every tool accepts optional `connection` (`default`, `stage`, `prod`, …).

---

## Time bounds

All query tools take `from` / `to` (e.g. `now-30m`, ISO-8601) or calendar `startDate` / `endDate` (`YYYY-MM-DD`, UTC day). `around` + `window` pin a pivot. Raw logs default to the last 30 minutes and cap at **7 days** unless `allowLongRange` is true. Never unbounded.

---

## Tools

### Core
| Tool | Purpose |
|------|---------|
| `dynatrace_health` | Connectivity + tiny Grail query |
| `dynatrace_list_connections` | Named connections |
| `dynatrace_execute_dql` | Raw DQL |
| `dynatrace_verify_dql` | Parse DQL without executing |
| `dynatrace_reset_grail_budget` | Clear session scan budget |
| `dynatrace_query_problems` | Davis problems (`search` optional) |
| `dynatrace_get_problem` | One problem (`P-123`) |
| `dynatrace_list_exceptions` | ERROR/exception logs |
| `dynatrace_k8s_events` | Cluster/pod events |
| `dynatrace_k8s_issue_events` | OOM / CrashLoop / Evicted / Warning |
| `dynatrace_get_entity_id` / `dynatrace_get_entity_name` | Entity lookup |

### Kubernetes Explorer
| Tool | Purpose |
|------|---------|
| `dynatrace_list_clusters` / `dynatrace_list_namespaces` | Inventory |
| `dynatrace_list_nodes` | Nodes by container CPU/mem |
| `dynatrace_list_pods` | Pod table from kube CPU/mem metrics (quiet pods included). `includeLogs` optional |
| `dynatrace_get_pod` | One pod: metrics status, entity, ready/restarts if present |
| `dynatrace_pod_issues` | CrashLoop / Warning events for one pod |
| `dynatrace_pod_utilization` | CPU / memory usage (quota tables) |
| `dynatrace_pod_quota` | Kubernetes Explorer CPU + Memory quota (requests, limits, %) |
| `dynatrace_pod_events` | Events for a pod/workload |
| `dynatrace_workload_status` | Desired vs ready |
| `dynatrace_service_health` | Failure rate / latency |
| `dynatrace_failed_spans` | Error spans by service |
| `dynatrace_slow_spans` | Highest-duration spans |
| `dynatrace_get_trace` | Spans (+ optional logs) by `trace_id` |

### Logs (summary → exact → surround)
| Tool | Purpose |
|------|---------|
| `dynatrace_log_summary` | Counts by level × pod × container |
| `dynatrace_search_logs` | Exact matching lines (limit 50/200) |
| `dynatrace_logs_surrounding` | ±30s around a hit timestamp |
| `dynatrace_pod_logs` | Last N lines for one pod |
| `dynatrace_logs_tail` | Poll new lines (`since` / `nextSince`) |
| `dynatrace_logs_wait` | Integration-test wait for a pattern (max 120s) |

Log filters: cluster, namespace, workload, pod(s), container, node, loglevel, contains / containsAll / containsAny / notContains / regex, trace/span id, excludePatterns, sample, date bounds. Content is truncated and likely secrets are redacted.

### Triage
| Tool | Purpose |
|------|---------|
| `dynatrace_triage_problem` | `P-id` or pasted alert → problem + pods + logs + quota + OOM/CrashLoop |
| `dynatrace_triage_scope` | Namespace/workload snapshot without a P-id |
| Prompt `dynatrace_triage_alert` | Full SRE workflow |

### Security & metrics
| Tool | Purpose |
|------|---------|
| `dynatrace_security_events_summary` | Aggregated security.events |
| `dynatrace_vulnerabilities` | Vulnerability summary |
| `dynatrace_compliance_findings` | Compliance summary |
| `dynatrace_metrics_query` | DQL timeseries or classic `/api/v2/metrics/query` |

---

## Typical triage

1. `dynatrace_list_clusters` / `dynatrace_list_namespaces` if the target is unknown
2. `dynatrace_triage_problem` (P-id) or `dynatrace_triage_scope` (cluster/namespace/workload)
3. `dynatrace_log_summary` then `dynatrace_search_logs` `loglevel=ERROR`
4. `dynatrace_logs_surrounding` on a match timestamp
5. `dynatrace_k8s_issue_events` / `dynatrace_pod_quota` / `dynatrace_get_pod`
6. `dynatrace_failed_spans` / `dynatrace_slow_spans` / `dynatrace_get_trace` if app latency or errors

## Integration test tail

```
dynatrace_logs_wait  pods=["my-app-7f8c9d4b6-abc12"] namespace=default contains="started" timeoutSeconds=60
dynatrace_logs_tail  pods=["my-app-7f8c9d4b6-abc12"] namespace=default since=<nextSince>
```

---

## Verify

```bash
export DYNATRACE_URL=https://abc12345.apps.dynatrace.com
export DYNATRACE_API_TOKEN=your-token
npm run build
npm run test:readonly
```

---

## License

MIT — Copyright © 2026 Ravi Raj
