/**
 * @raviraj87/dynatrace-mcp · tools/triageTools.ts
 * Composite problem triage and MCP prompt.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../client.js";
import {
  dqlFailedSpans,
  dqlK8sIssueEvents,
  dqlListPodsFromMetrics,
  dqlPodQuota,
  dqlPodRestarts,
  dqlServiceHealth,
  dqlWorkloadStatus,
} from "../dql/k8s.js";
import { dqlLogSummary, dqlSearchLogs } from "../dql/logs.js";
import { dqlGetProblem, dqlQueryProblems, extractK8sHints, extractProblemId } from "../dql/problems.js";
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
  k8sPodField,
  k8sWorkloadField,
} from "./common.js";

async function tryDql(manager: ConnectionManager, connection: string | undefined, dql: string, max = 50) {
  try {
    return { ok: true as const, result: await runDql(manager, connection, dql, max) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

function pack(q: Awaited<ReturnType<typeof tryDql>>, maxChars: number) {
  return q.ok ? presentQuery(q.result, maxChars) : { error: q.error };
}

export function registerTriageTools(server: McpServer, manager: ConnectionManager): void {
  server.registerTool(
    "dynatrace_triage_problem",
    {
      title: "Triage Problem",
      description:
        "Investigate a Davis problem: problem record, kube pods/quota, ERROR logs, OOM/CrashLoop events. Pass P-123 or paste alert text. Optional cluster/namespace/workload override extracted hints.",
      inputSchema: {
        connection: connectionField,
        problemId: z.string().optional().describe("P-123456 or event id"),
        alertText: z.string().optional().describe("PagerDuty/chat paste; P-id is extracted"),
        namespace: k8sNamespaceField,
        cluster: k8sClusterField,
        workload: k8sWorkloadField,
        ...timeFields,
      },
    },
    async ({ connection, problemId, alertText, namespace, cluster, workload, ...time }) => {
      try {
        const id = problemId?.trim() || (alertText ? extractProblemId(alertText) : undefined);
        if (!id) {
          return jsonResult({ error: "Provide problemId (P-123) or alertText containing a P- id" });
        }
        const bounds = boundsFromArgs(time, "now-30m", time.allowLongRange ? 30 * 86_400_000 : 7 * 86_400_000);
        const problem = await tryDql(manager, connection, dqlGetProblem(bounds, id), 5);
        const desc =
          problem.ok && problem.result.records[0]
            ? String(problem.result.records[0]["event.description"] ?? "")
            : alertText ?? "";
        const hints = extractK8sHints(`${desc}\n${alertText ?? ""}`);
        const scope = {
          cluster: cluster || hints.cluster,
          namespace: namespace || hints.namespace,
          workload: workload || hints.workload,
          pod: hints.pod,
        };

        const [pods, summary, errors, issues, quota, replicas] = await Promise.all([
          tryDql(manager, connection, dqlListPodsFromMetrics(bounds, { ...scope, limit: 20 }), 20),
          tryDql(manager, connection, dqlLogSummary(bounds, { ...scope, loglevel: ["ERROR", "WARN"], limit: 30 }), 30),
          tryDql(manager, connection, dqlSearchLogs(bounds, { ...scope, loglevel: ["ERROR"], limit: 20 }), 20),
          tryDql(manager, connection, dqlK8sIssueEvents(bounds, { ...scope, limit: 30 }), 30),
          tryDql(manager, connection, dqlPodQuota(bounds, { ...scope, limit: 20 }), 20),
          tryDql(manager, connection, dqlWorkloadStatus(bounds, scope), 20),
        ]);

        return jsonResult({
          bounds,
          problemId: id,
          scope,
          hints,
          problem: pack(problem, 8000),
          pods: pack(pods, 400),
          logSummary: pack(summary, 400),
          errorLogs: pack(errors, 2000),
          issueEvents: pack(issues, 2000),
          quota: pack(quota, 400),
          workloadReplicas: pack(replicas, 400),
          next: "dynatrace_logs_surrounding on an error timestamp; dynatrace_pod_issues / dynatrace_get_pod; dynatrace_failed_spans if latency/errors; dynatrace_triage_scope if no P-id.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_triage_scope",
    {
      title: "Triage Cluster/Namespace/Workload",
      description:
        "SRE snapshot without a problem id: active Davis problems, OOM/CrashLoop events, ERROR log counts, CPU/memory quota hotspots, replica mismatch, restarts, service golden signals, failed spans. Pass the user's cluster/namespace/workload (discover first). Default window 30m.",
      inputSchema: {
        connection: connectionField,
        cluster: k8sClusterField,
        namespace: k8sNamespaceField,
        workload: k8sWorkloadField,
        pod: k8sPodField,
        service: z.string().optional().describe("Optional service name for traces/golden signals"),
        ...timeFields,
      },
    },
    async ({ connection, cluster, namespace, workload, pod, service, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        const scope = { cluster, namespace, workload, pod };
        const search = [namespace, workload, pod, service].filter(Boolean).join(" ");
        const [problems, issues, summary, errors, quota, replicas, restarts, health, failed] = await Promise.all([
          tryDql(manager, connection, dqlQueryProblems(bounds, "ACTIVE", 25, search || undefined), 25),
          tryDql(manager, connection, dqlK8sIssueEvents(bounds, { ...scope, limit: 40 }), 40),
          tryDql(manager, connection, dqlLogSummary(bounds, { ...scope, loglevel: ["ERROR", "WARN"], limit: 40 }), 40),
          tryDql(manager, connection, dqlSearchLogs(bounds, { ...scope, loglevel: ["ERROR"], limit: 15 }), 15),
          tryDql(manager, connection, dqlPodQuota(bounds, { ...scope, limit: 25 }), 25),
          tryDql(manager, connection, dqlWorkloadStatus(bounds, scope), 25),
          tryDql(manager, connection, dqlPodRestarts(bounds, scope), 25),
          tryDql(manager, connection, dqlServiceHealth(bounds, { service, namespace, workload }), 20),
          tryDql(manager, connection, dqlFailedSpans(bounds, { service, namespace, limit: 20 }), 20),
        ]);
        return jsonResult({
          bounds,
          scope,
          problems: pack(problems, 4000),
          issueEvents: pack(issues, 2500),
          logSummary: pack(summary, 400),
          errorLogs: pack(errors, 1500),
          quota: pack(quota, 400),
          workloadReplicas: pack(replicas, 400),
          restarts: pack(restarts, 400),
          serviceHealth: pack(health, 400),
          failedSpans: pack(failed, 400),
          next: "Drill with dynatrace_search_logs, dynatrace_logs_surrounding, dynatrace_get_pod, dynatrace_slow_spans, dynatrace_get_trace.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerPrompt(
    "dynatrace_triage_alert",
    {
      title: "Triage Dynatrace Alert",
      description: "Full SRE workflow: discover scope → problems/snapshot → logs → pod quota/events → traces.",
      argsSchema: {
        alert: z.string().describe("PagerDuty, Davis, or free-text symptom (optional P-id)"),
      },
    },
    async ({ alert }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Triage this incident using the Dynatrace MCP only (no Dynatrace UI). Do not assume cluster, namespace, or pod names.

Alert / symptom:
${alert}

Required order:
1. If a P-id is present: dynatrace_triage_problem. Else dynatrace_list_clusters / dynatrace_list_namespaces then dynatrace_triage_scope with the user's scope.
2. dynatrace_log_summary (ERROR/WARN) then dynatrace_search_logs (limit 50) then dynatrace_logs_surrounding on the best timestamp.
3. Kubernetes: dynatrace_k8s_issue_events (OOM/CrashLoop), dynatrace_pod_quota, dynatrace_workload_status, dynatrace_get_pod / dynatrace_pod_issues for hot pods, dynatrace_list_nodes if node-level.
4. App: dynatrace_service_health, dynatrace_failed_spans / dynatrace_slow_spans, dynatrace_get_trace if a trace_id appears.
5. Security only if the alert is vuln/compliance: dynatrace_vulnerabilities / dynatrace_security_events_summary.

Do not fetch unbounded logs. Respect date bounds. Cite evidence (pod, timestamp, metric). Summarize likely root cause and next checks.`,
          },
        },
      ],
    }),
  );
}
