/**
 * @raviraj87/dynatrace-mcp · tools/k8sTools.ts
 * Kubernetes Explorer-style pod, workload, utilization, and trace tools.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../client.js";
import {
  dqlFailedSpans,
  dqlGetTrace,
  dqlK8sEvents,
  dqlK8sIssueEvents,
  dqlListClusters,
  dqlListNamespaces,
  dqlListNodes,
  dqlListPods,
  dqlListPodsFromLogs,
  dqlListPodsFromMetrics,
  dqlPodQuota,
  dqlPodReady,
  dqlPodRestarts,
  dqlServiceHealth,
  dqlSlowSpans,
  dqlWorkloadStatus,
} from "../dql/k8s.js";
import {
  connectionField,
  errorResult,
  jsonResult,
  presentQuery,
  runDql,
  timeFields,
  boundsFromArgs,
  k8sClusterField,
  k8sNamespaceField,
  k8sWorkloadField,
  k8sPodField,
} from "./common.js";

async function tryDql(manager: ConnectionManager, connection: string | undefined, dql: string, max = 100) {
  try {
    return await runDql(manager, connection, dql, max);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), records: [] as Record<string, unknown>[] };
  }
}

function metricPodRows(records: Record<string, unknown>[]) {
  return records.map((r) => {
    const mem = r.memBytes;
    const memNum = typeof mem === "number" ? mem : Number(mem);
    return {
      cluster: r["k8s.cluster.name"],
      namespace: r["k8s.namespace.name"],
      workload: r["k8s.workload.name"],
      pod: r["k8s.pod.name"],
      container: r["k8s.container.name"],
      cpuMilli: r.cpuMilli,
      memMiB: Number.isFinite(memNum) ? Math.round((memNum / 1_048_576) * 10) / 10 : undefined,
      status: r.cpuMilli != null || Number.isFinite(memNum) ? "Running" : "Unknown",
    };
  });
}

function asNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function round(n: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function pct(usage: number | undefined, cap: number | undefined): number | undefined {
  if (usage == null || cap == null || cap <= 0) return undefined;
  return round((usage / cap) * 100, 2);
}

/** Match Kubernetes Explorer: MB/GB in decimal bytes. */
function bytesDisplay(bytes: number | undefined): { value: number; unit: string } | undefined {
  if (bytes == null) return undefined;
  if (Math.abs(bytes) >= 1_000_000_000) return { value: round(bytes / 1_000_000_000, 2), unit: "GB" };
  if (Math.abs(bytes) >= 1_000_000) return { value: round(bytes / 1_000_000, 2), unit: "MB" };
  if (Math.abs(bytes) >= 1_000) return { value: round(bytes / 1_000, 2), unit: "kB" };
  return { value: round(bytes, 2), unit: "B" };
}

function formatQuotaRows(records: Record<string, unknown>[]) {
  type Agg = {
    cluster: unknown;
    namespace: unknown;
    workload: unknown;
    pod: unknown;
    cpuUsage: number;
    cpuThrottled: number;
    cpuRequests: number;
    cpuLimits: number;
    memUsage: number;
    memRequests: number;
    memLimits: number;
  };
  const byPod = new Map<string, Agg>();
  for (const r of records) {
    const pod = String(r["k8s.pod.name"] ?? "");
    const key = `${r["k8s.cluster.name"]}|${r["k8s.namespace.name"]}|${pod}`;
    const cur = byPod.get(key) ?? {
      cluster: r["k8s.cluster.name"],
      namespace: r["k8s.namespace.name"],
      workload: r["k8s.workload.name"],
      pod,
      cpuUsage: 0,
      cpuThrottled: 0,
      cpuRequests: 0,
      cpuLimits: 0,
      memUsage: 0,
      memRequests: 0,
      memLimits: 0,
    };
    cur.cpuUsage += asNum(r.cpuUsage) ?? 0;
    cur.cpuThrottled += asNum(r.cpuThrottled) ?? 0;
    cur.cpuRequests += asNum(r.cpuRequests) ?? 0;
    cur.cpuLimits += asNum(r.cpuLimits) ?? 0;
    cur.memUsage += asNum(r.memUsage) ?? 0;
    cur.memRequests += asNum(r.memRequests) ?? 0;
    cur.memLimits += asNum(r.memLimits) ?? 0;
    byPod.set(key, cur);
  }

  const cpu = [...byPod.values()]
    .map((p) => ({
      cluster: p.cluster,
      namespace: p.namespace,
      workload: p.workload,
      pod: p.pod,
      usageMilli: round(p.cpuUsage, 1),
      throttledMilli: round(p.cpuThrottled, 1),
      requestsMilli: round(p.cpuRequests, 1),
      limitsMilli: round(p.cpuLimits, 1),
      pctOfRequests: pct(p.cpuUsage, p.cpuRequests),
      pctOfLimits: pct(p.cpuUsage, p.cpuLimits),
      unusedMilli: round(Math.max(p.cpuRequests - p.cpuUsage, 0), 1),
    }))
    .sort((a, b) => b.usageMilli - a.usageMilli);

  const memory = [...byPod.values()]
    .sort((a, b) => b.memUsage - a.memUsage)
    .map((p) => ({
      cluster: p.cluster,
      namespace: p.namespace,
      workload: p.workload,
      pod: p.pod,
      usage: bytesDisplay(p.memUsage),
      requests: bytesDisplay(p.memRequests),
      limits: bytesDisplay(p.memLimits),
      pctOfRequests: pct(p.memUsage, p.memRequests),
      pctOfLimits: pct(p.memUsage, p.memLimits),
      unused: bytesDisplay(Math.max(p.memRequests - p.memUsage, 0)),
    }));

  return { cpu, memory };
}

export function registerK8sTools(server: McpServer, manager: ConnectionManager): void {
  server.registerTool(
    "dynatrace_list_clusters",
    {
      title: "List Kubernetes Clusters",
      description: "List Kubernetes clusters known to this Dynatrace tenant (k8s.cluster.name). Call this before filtering pods.",
      inputSchema: { connection: connectionField, ...timeFields },
    },
    async ({ connection, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h", 30 * 86_400_000);
        const result = await tryDql(manager, connection, dqlListClusters(bounds), 100);
        if ("error" in result && result.error) {
          const fallback = await runDql(
            manager,
            connection,
            `fetch logs, from:now()-2h | filter isNotNull(k8s.cluster.name) | summarize pods=count(), by:{k8s.cluster.name} | limit 50`,
            50,
          );
          return jsonResult({ bounds, source: "logs", ...presentQuery(fallback, 200) });
        }
        return jsonResult({ bounds, ...presentQuery(result as Awaited<ReturnType<typeof runDql>>, 200) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_list_namespaces",
    {
      title: "List Kubernetes Namespaces",
      description: "List namespaces in this tenant, optionally filtered by cluster.",
      inputSchema: { connection: connectionField, cluster: k8sClusterField, ...timeFields },
    },
    async ({ connection, cluster, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h", 30 * 86_400_000);
        const result = await tryDql(manager, connection, dqlListNamespaces(bounds, cluster), 200);
        if ("error" in result && result.error) {
          const extra = cluster ? `| filter k8s.cluster.name == "${cluster.replace(/"/g, "")}"` : "";
          const fallback = await runDql(
            manager,
            connection,
            `fetch logs, from:now()-2h ${extra} | filter isNotNull(k8s.namespace.name) | summarize count=count(), by:{k8s.cluster.name, k8s.namespace.name} | limit 200`,
            200,
          );
          return jsonResult({ bounds, source: "logs", ...presentQuery(fallback, 200) });
        }
        return jsonResult({ bounds, ...presentQuery(result as Awaited<ReturnType<typeof runDql>>, 200) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_list_nodes",
    {
      title: "List Kubernetes Nodes",
      description:
        "Nodes ranked by container CPU/memory on that node. Pass cluster from dynatrace_list_clusters.",
      inputSchema: {
        connection: connectionField,
        cluster: k8sClusterField,
        limit: z.number().int().positive().max(200).optional(),
        ...timeFields,
      },
    },
    async ({ connection, cluster, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-15m");
        const result = await runDql(manager, connection, dqlListNodes(bounds, { cluster, limit: limit ?? 50 }), limit ?? 50);
        return jsonResult({ bounds, ...presentQuery(result, 400) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_list_pods",
    {
      title: "List Pods",
      description:
        "Pod table from kube CPU/memory metrics for any cluster/namespace/workload. Quiet pods (no logs) are included. Pass filters from list_clusters / list_namespaces or the user; do not assume names. Unfiltered lists are capped. includeLogs is an optional extra Grail scan.",
      inputSchema: {
        connection: connectionField,
        cluster: k8sClusterField,
        namespace: k8sNamespaceField,
        workload: k8sWorkloadField,
        pod: k8sPodField,
        limit: z.number().int().positive().max(200).optional(),
        includeLogs: z.boolean().optional().describe("Also list pods that emitted logs (expensive Grail scan)"),
        ...timeFields,
      },
    },
    async ({ connection, cluster, namespace, workload, pod, limit, includeLogs, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const opts = { cluster, namespace, workload, pod, limit };
        const metrics = await tryDql(manager, connection, dqlListPodsFromMetrics(bounds, opts), limit ?? 50);
        const entities = await tryDql(manager, connection, dqlListPods(bounds, opts), limit ?? 50);
        const fromLogs = includeLogs
          ? await tryDql(manager, connection, dqlListPodsFromLogs(bounds, opts), limit ?? 50)
          : undefined;
        const pods =
          "error" in metrics && metrics.error ? undefined : metricPodRows((metrics as Awaited<ReturnType<typeof runDql>>).records);
        return jsonResult({
          bounds,
          source: "kube-metrics",
          pods,
          metrics: "error" in metrics ? { error: metrics.error } : presentQuery(metrics as Awaited<ReturnType<typeof runDql>>, 400),
          entities: "error" in entities ? { error: entities.error } : presentQuery(entities as Awaited<ReturnType<typeof runDql>>, 400),
          fromLogs: fromLogs
            ? "error" in fromLogs
              ? { error: fromLogs.error }
              : presentQuery(fromLogs as Awaited<ReturnType<typeof runDql>>, 400)
            : undefined,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_get_pod",
    {
      title: "Get Pod",
      description: "Detail for one pod: kube-metrics status (CPU/mem), entity lifetime, ready/restarts if ingested.",
      inputSchema: {
        connection: connectionField,
        pod: z.string().min(1).describe("Exact pod name (from list_pods or the user)"),
        namespace: k8sNamespaceField,
        cluster: k8sClusterField,
        ...timeFields,
      },
    },
    async ({ connection, pod, namespace, cluster, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const opts = { cluster, namespace, pod };
        const [metrics, detail, ready, restarts] = await Promise.all([
          tryDql(manager, connection, dqlListPodsFromMetrics(bounds, { ...opts, limit: 10 }), 10),
          tryDql(manager, connection, dqlListPods(bounds, { ...opts, limit: 10 }), 10),
          tryDql(manager, connection, dqlPodReady(bounds, opts), 20),
          tryDql(manager, connection, dqlPodRestarts(bounds, opts), 20),
        ]);
        const pods =
          "error" in metrics && metrics.error
            ? undefined
            : metricPodRows((metrics as Awaited<ReturnType<typeof runDql>>).records);
        return jsonResult({
          bounds,
          pod,
          namespace,
          cluster,
          status: pods?.[0],
          metrics: "error" in metrics ? { error: metrics.error } : presentQuery(metrics as Awaited<ReturnType<typeof runDql>>, 400),
          detail: "error" in detail ? { error: detail.error } : presentQuery(detail as Awaited<ReturnType<typeof runDql>>, 400),
          ready: "error" in ready ? { error: ready.error } : presentQuery(ready as Awaited<ReturnType<typeof runDql>>, 400),
          restarts: "error" in restarts ? { error: restarts.error } : presentQuery(restarts as Awaited<ReturnType<typeof runDql>>, 400),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_pod_issues",
    {
      title: "Pod Issues",
      description: "CrashLoop / OOM / not-Ready signals: restarts plus Warning events for a pod.",
      inputSchema: {
        connection: connectionField,
        pod: z.string().min(1).describe("Exact pod name (from list_pods or the user)"),
        namespace: k8sNamespaceField,
        cluster: k8sClusterField,
        ...timeFields,
      },
    },
    async ({ connection, pod, namespace, cluster, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h");
        const [restarts, events] = await Promise.all([
          tryDql(manager, connection, dqlPodRestarts(bounds, { cluster, namespace, pod }), 20),
          tryDql(
            manager,
            connection,
            dqlK8sEvents(bounds, { cluster, namespace, pod, limit: 50 }),
            50,
          ),
        ]);
        return jsonResult({
          bounds,
          pod,
          restarts: "error" in restarts ? { error: restarts.error } : presentQuery(restarts as Awaited<ReturnType<typeof runDql>>, 400),
          events: "error" in events ? { error: events.error } : presentQuery(events as Awaited<ReturnType<typeof runDql>>, 2000),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_pod_utilization",
    {
      title: "Pod Utilization",
      description:
        "Kubernetes Explorer CPU and Memory quota: usage, throttled, requests, limits, % of request/limit, unused. Filter by cluster/namespace/workload/pod. Same report as dynatrace_pod_quota.",
      inputSchema: {
        connection: connectionField,
        pod: k8sPodField,
        workload: k8sWorkloadField,
        namespace: k8sNamespaceField,
        cluster: k8sClusterField,
        limit: z.number().int().positive().max(200).optional(),
        ...timeFields,
      },
    },
    async ({ connection, pod, workload, namespace, cluster, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const result = await runDql(
          manager,
          connection,
          dqlPodQuota(bounds, { cluster, namespace, pod, workload, limit: limit ?? 50 }),
          limit ?? 50,
        );
        return jsonResult({ bounds, ...formatQuotaRows(result.records), ...presentQuery(result, 200) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_pod_quota",
    {
      title: "Pod CPU/Memory Quota",
      description:
        "Kubernetes Explorer quota tables for any namespace: CPU (mcore usage, throttled, requests, limits, %, unused) and Memory (usage, requests, limits, %, unused). Discover cluster/namespace first; do not assume names.",
      inputSchema: {
        connection: connectionField,
        cluster: k8sClusterField,
        namespace: k8sNamespaceField,
        workload: k8sWorkloadField,
        pod: k8sPodField,
        limit: z.number().int().positive().max(200).optional(),
        sort: z.enum(["cpu", "memory"]).optional().describe("Which table is listed first (default cpu)"),
        ...timeFields,
      },
    },
    async ({ connection, cluster, namespace, workload, pod, limit, sort, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-15m");
        const result = await runDql(
          manager,
          connection,
          dqlPodQuota(bounds, { cluster, namespace, pod, workload, limit: limit ?? 50 }),
          limit ?? 50,
        );
        const tables = formatQuotaRows(result.records);
        const ordered = sort === "memory" ? { memory: tables.memory, cpu: tables.cpu } : tables;
        return jsonResult({ bounds, sort: sort ?? "cpu", ...ordered });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_pod_events",
    {
      title: "Pod Events",
      description: "Kubernetes events for one pod or workload (Explorer Events tab).",
      inputSchema: {
        connection: connectionField,
        pod: k8sPodField,
        workload: k8sWorkloadField,
        namespace: k8sNamespaceField,
        cluster: k8sClusterField,
        limit: z.number().int().positive().max(200).optional(),
        ...timeFields,
      },
    },
    async ({ connection, pod, workload, namespace, cluster, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h");
        const result = await runDql(
          manager,
          connection,
          dqlK8sEvents(bounds, { cluster, namespace, pod, workload, limit }),
          limit ?? 100,
        );
        return jsonResult({ bounds, ...presentQuery(result, 3000) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_k8s_issue_events",
    {
      title: "Kubernetes Issue Events",
      description:
        "OOMKilled, CrashLoop/BackOff, Evicted, Failed, Unhealthy, probe failures, Warning events. Scope with cluster/namespace/workload/pod.",
      inputSchema: {
        connection: connectionField,
        cluster: k8sClusterField,
        namespace: k8sNamespaceField,
        workload: k8sWorkloadField,
        pod: k8sPodField,
        limit: z.number().int().positive().max(200).optional(),
        ...timeFields,
      },
    },
    async ({ connection, cluster, namespace, workload, pod, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h");
        const result = await runDql(
          manager,
          connection,
          dqlK8sIssueEvents(bounds, { cluster, namespace, pod, workload, limit: limit ?? 50 }),
          limit ?? 50,
        );
        return jsonResult({ bounds, ...presentQuery(result, 3000) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_workload_status",
    {
      title: "Workload Status",
      description: "Desired vs ready replicas for a Kubernetes workload (covers No pod ready).",
      inputSchema: {
        connection: connectionField,
        workload: k8sWorkloadField,
        namespace: k8sNamespaceField,
        cluster: k8sClusterField,
        ...timeFields,
      },
    },
    async ({ connection, workload, namespace, cluster, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const result = await tryDql(
          manager,
          connection,
          dqlWorkloadStatus(bounds, { cluster, namespace, workload }),
          50,
        );
        return jsonResult({
          bounds,
          ...("error" in result && result.error
            ? { error: result.error }
            : presentQuery(result as Awaited<ReturnType<typeof runDql>>, 400)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_service_health",
    {
      title: "Service Health",
      description: "Request count, failure count, and response time for a service/workload.",
      inputSchema: {
        connection: connectionField,
        service: z.string().optional().describe("Service name substring or entity id"),
        workload: k8sWorkloadField,
        namespace: k8sNamespaceField,
        ...timeFields,
      },
    },
    async ({ connection, service, workload, namespace, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const result = await tryDql(manager, connection, dqlServiceHealth(bounds, { service, workload, namespace }), 50);
        return jsonResult({
          bounds,
          ...("error" in result && result.error
            ? { error: result.error }
            : presentQuery(result as Awaited<ReturnType<typeof runDql>>, 400)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_get_trace",
    {
      title: "Get Trace",
      description: "Fetch spans for a trace_id (from a log line) plus optional linked logs.",
      inputSchema: {
        connection: connectionField,
        traceId: z.string().min(1),
        includeLogs: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
        ...timeFields,
      },
    },
    async ({ connection, traceId, includeLogs, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h");
        const spans = await tryDql(manager, connection, dqlGetTrace(bounds, traceId, limit), limit ?? 50);
        let logs: unknown;
        if (includeLogs) {
          logs = await tryDql(
            manager,
            connection,
            `fetch logs, from:now()-2h | filter trace_id == "${traceId.replace(/"/g, "")}" or dt.trace_id == "${traceId.replace(/"/g, "")}" | fields timestamp, loglevel, content, k8s.pod.name | sort timestamp asc | limit 50`,
            50,
          );
        }
        return jsonResult({
          bounds,
          traceId,
          spans: "error" in spans && spans.error ? { error: spans.error } : presentQuery(spans as Awaited<ReturnType<typeof runDql>>, 1500),
          logs:
            logs && typeof logs === "object" && "error" in (logs as object)
              ? logs
              : logs
                ? presentQuery(logs as Awaited<ReturnType<typeof runDql>>, 2000)
                : undefined,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_failed_spans",
    {
      title: "Failed Spans",
      description: "Error spans grouped by service/span/pod. Use after service_health shows failures or for latency vs error triage.",
      inputSchema: {
        connection: connectionField,
        service: z.string().optional().describe("Service name substring"),
        namespace: k8sNamespaceField,
        limit: z.number().int().positive().max(100).optional(),
        ...timeFields,
      },
    },
    async ({ connection, service, namespace, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const result = await tryDql(
          manager,
          connection,
          dqlFailedSpans(bounds, { service, namespace, limit: limit ?? 30 }),
          limit ?? 30,
        );
        return jsonResult({
          bounds,
          ...("error" in result && result.error
            ? { error: result.error }
            : presentQuery(result as Awaited<ReturnType<typeof runDql>>, 400)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_slow_spans",
    {
      title: "Slow Spans",
      description: "Highest-duration spans in the window (latency triage). Follow a row with dynatrace_get_trace.",
      inputSchema: {
        connection: connectionField,
        service: z.string().optional().describe("Service name substring"),
        namespace: k8sNamespaceField,
        limit: z.number().int().positive().max(100).optional(),
        ...timeFields,
      },
    },
    async ({ connection, service, namespace, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const result = await tryDql(
          manager,
          connection,
          dqlSlowSpans(bounds, { service, namespace, limit: limit ?? 30 }),
          limit ?? 30,
        );
        return jsonResult({
          bounds,
          ...("error" in result && result.error
            ? { error: result.error }
            : presentQuery(result as Awaited<ReturnType<typeof runDql>>, 1500)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
