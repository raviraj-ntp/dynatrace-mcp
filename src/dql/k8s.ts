/**
 * @raviraj87/dynatrace-mcp · dql/k8s.ts
 * Kubernetes entity, event, workload, and metrics DQL templates.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { TimeBounds } from "../types.js";
import { fetchTimeClause } from "../time.js";
import { andFilters, dqlString, eqField, k8sPodFilter, k8sWorkloadFilter } from "./escape.js";

export function dqlK8sEvents(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; pod?: string; workload?: string; findAll?: boolean; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const filters = opts.findAll
    ? andFilters([`isNotNull(k8s.cluster.name) or isNotNull(dt.entity.kubernetes_cluster)`])
    : andFilters([
        eqField("k8s.cluster.name", opts.cluster),
        eqField("k8s.namespace.name", opts.namespace),
        k8sPodFilter(opts.pod),
        k8sWorkloadFilter(opts.workload),
      ]);
  return `fetch events, ${fetchTimeClause(bounds)}
${filters || `| filter isNotNull(k8s.cluster.name) or isNotNull(k8s.pod.name)`}
| fields timestamp, event.name, event.type, event.provider, event.kind, k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.workload.name, k8s.node.name, content
| sort timestamp desc
| limit ${limit}`;
}

export function dqlListClusters(bounds: TimeBounds): string {
  return `fetch dt.entity.kubernetes_cluster, ${fetchTimeClause(bounds)}
| fields id, entity.name
| limit 100`;
}

export function dqlListNamespaces(bounds: TimeBounds, cluster?: string): string {
  const filter = eqField("k8s.cluster.name", cluster);
  return `fetch dt.entity.cloud_application_namespace, ${fetchTimeClause(bounds)}
${filter ? `| filter ${filter}` : ""}
| fields id, entity.name
| fieldsAdd k8s.cluster.name, k8s.namespace.name
| limit 200`;
}

export function dqlListPods(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; workload?: string; pod?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const name = opts.pod?.trim() || opts.workload?.trim();
  const filters = andFilters([
    k8sPodFilter(opts.pod, "entity.name") ??
      (opts.workload ? k8sPodFilter(opts.workload, "entity.name") : undefined) ??
      (name ? `contains(entity.name, ${dqlString(name)})` : undefined),
  ]);
  return `fetch dt.entity.cloud_application_instance, ${fetchTimeClause(bounds)}
${filters}
| fields id, entity.name, lifetime
| limit ${limit}`;
}

/** Live pods from kube container metrics — includes replicas that emit no logs. */
export function dqlListPodsFromMetrics(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; workload?: string; pod?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters = andFilters([
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sWorkloadFilter(opts.workload),
    k8sPodFilter(opts.pod),
  ]);
  return `timeseries avg(dt.kubernetes.container.cpu_usage), avg(dt.kubernetes.container.memory_working_set), by:{k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.container.name, k8s.workload.name}, ${fetchTimeClause(bounds)}
${filters}
| fieldsAdd cpuMilli=arrayLast(\`avg(dt.kubernetes.container.cpu_usage)\`), memBytes=arrayLast(\`avg(dt.kubernetes.container.memory_working_set)\`)
| fields k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.container.name, k8s.workload.name, cpuMilli, memBytes
| sort k8s.pod.name
| limit ${limit}`;
}

export function dqlListPodsFromLogs(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; workload?: string; pod?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters = andFilters([
    `isNotNull(k8s.pod.name)`,
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sWorkloadFilter(opts.workload, ["k8s.workload.name", "k8s.deployment.name"]),
    k8sPodFilter(opts.pod),
  ]);
  return `fetch logs, ${fetchTimeClause(bounds)}
${filters}
| summarize lastSeen=max(timestamp), containers=collectDistinct(k8s.container.name), by:{k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.workload.name, k8s.node.name}
| sort lastSeen desc
| limit ${limit}`;
}

export function dqlPodReady(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; pod?: string },
): string {
  const filters = andFilters([
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sPodFilter(opts.pod),
  ]);
  return `timeseries avg(dt.kubernetes.pods.ready), by:{k8s.cluster.name, k8s.namespace.name, k8s.pod.name}, ${fetchTimeClause(bounds)}
${filters}`;
}

export function dqlPodRestarts(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; pod?: string },
): string {
  const filters = andFilters([
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sPodFilter(opts.pod),
  ]);
  return `timeseries max(dt.kubernetes.container.restarts), by:{k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.container.name}, ${fetchTimeClause(bounds)}
${filters}`;
}

export function dqlPodUtilization(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; pod?: string; workload?: string },
): string {
  return dqlPodQuota(bounds, { ...opts, limit: 50 });
}

/** Kubernetes Explorer CPU + Memory quota: usage, requests, limits (last sample). */
export function dqlPodQuota(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; pod?: string; workload?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters = andFilters([
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sPodFilter(opts.pod),
    k8sWorkloadFilter(opts.workload),
  ]);
  return `timeseries avg(dt.kubernetes.container.cpu_usage), avg(dt.kubernetes.container.cpu_throttled), avg(dt.kubernetes.container.requests_cpu), avg(dt.kubernetes.container.limits_cpu), avg(dt.kubernetes.container.memory_working_set), avg(dt.kubernetes.container.requests_memory), avg(dt.kubernetes.container.limits_memory), by:{k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.container.name, k8s.workload.name}, ${fetchTimeClause(bounds)}
${filters}
| fieldsAdd cpuUsage=arrayLast(\`avg(dt.kubernetes.container.cpu_usage)\`), cpuThrottled=arrayLast(\`avg(dt.kubernetes.container.cpu_throttled)\`), cpuRequests=arrayLast(\`avg(dt.kubernetes.container.requests_cpu)\`), cpuLimits=arrayLast(\`avg(dt.kubernetes.container.limits_cpu)\`), memUsage=arrayLast(\`avg(dt.kubernetes.container.memory_working_set)\`), memRequests=arrayLast(\`avg(dt.kubernetes.container.requests_memory)\`), memLimits=arrayLast(\`avg(dt.kubernetes.container.limits_memory)\`)
| fields k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.container.name, k8s.workload.name, cpuUsage, cpuThrottled, cpuRequests, cpuLimits, memUsage, memRequests, memLimits
| sort cpuUsage desc
| limit ${limit}`;
}

export function dqlWorkloadStatus(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; workload?: string },
): string {
  const filters = andFilters([
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sWorkloadFilter(opts.workload),
  ]);
  return `timeseries avg(dt.kubernetes.workloads.desired_replicas), avg(dt.kubernetes.workloads.ready_replicas), by:{k8s.cluster.name, k8s.namespace.name, k8s.workload.name}, ${fetchTimeClause(bounds)}
${filters}`;
}

export function dqlServiceHealth(
  bounds: TimeBounds,
  opts: { service?: string; namespace?: string; workload?: string },
): string {
  const filters = andFilters([
    eqField("k8s.namespace.name", opts.namespace),
    k8sWorkloadFilter(opts.workload),
    opts.service ? `contains(entity.name, ${dqlString(opts.service)}) or dt.entity.service == ${dqlString(opts.service)}` : undefined,
  ]);
  return `timeseries avg(dt.service.request.response.time), avg(dt.service.request.failure_count), avg(dt.service.request.count), by:{dt.entity.service}, ${fetchTimeClause(bounds)}
${filters}`;
}

export function dqlListNodes(
  bounds: TimeBounds,
  opts: { cluster?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters = andFilters([eqField("k8s.cluster.name", opts.cluster)]);
  return `timeseries avg(dt.kubernetes.container.cpu_usage), avg(dt.kubernetes.container.memory_working_set), by:{k8s.cluster.name, k8s.node.name}, ${fetchTimeClause(bounds)}
${filters}
| fieldsAdd cpuMilli=arrayLast(\`avg(dt.kubernetes.container.cpu_usage)\`), memBytes=arrayLast(\`avg(dt.kubernetes.container.memory_working_set)\`)
| fields k8s.cluster.name, k8s.node.name, cpuMilli, memBytes
| sort cpuMilli desc
| limit ${limit}`;
}

export function dqlK8sIssueEvents(
  bounds: TimeBounds,
  opts: { cluster?: string; namespace?: string; pod?: string; workload?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters = andFilters([
    eqField("k8s.cluster.name", opts.cluster),
    eqField("k8s.namespace.name", opts.namespace),
    k8sPodFilter(opts.pod),
    k8sWorkloadFilter(opts.workload),
  ]);
  return `fetch events, ${fetchTimeClause(bounds)}
${filters}
| filter event.kind == "WARNING" or event.status == "WARNING" or contains(event.name, "OOM") or contains(event.name, "BackOff") or contains(event.name, "Failed") or contains(event.name, "Evicted") or contains(event.name, "Unhealthy") or contains(event.name, "Killing") or contains(event.name, "Probe") or contains(content, "CrashLoop")
| fields timestamp, event.name, event.type, event.kind, k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.workload.name, k8s.node.name, content
| sort timestamp desc
| limit ${limit}`;
}

export function dqlFailedSpans(
  bounds: TimeBounds,
  opts: { service?: string; namespace?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const filters = andFilters([
    eqField("k8s.namespace.name", opts.namespace),
    opts.service
      ? `contains(service.name, ${dqlString(opts.service)}) or dt.entity.service == ${dqlString(opts.service)}`
      : undefined,
  ]);
  return `fetch spans, ${fetchTimeClause(bounds)}
${filters}
| filter span.status.code == "ERROR" or span.status.code == 2 or span.status.code == "STATUS_CODE_ERROR"
| summarize errors=count(), by:{service.name, span.name, k8s.namespace.name, k8s.pod.name}
| sort errors desc
| limit ${limit}`;
}

export function dqlSlowSpans(
  bounds: TimeBounds,
  opts: { service?: string; namespace?: string; limit?: number },
): string {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const filters = andFilters([
    eqField("k8s.namespace.name", opts.namespace),
    opts.service
      ? `contains(service.name, ${dqlString(opts.service)}) or dt.entity.service == ${dqlString(opts.service)}`
      : undefined,
  ]);
  return `fetch spans, ${fetchTimeClause(bounds)}
${filters}
| fields timestamp, duration, span.name, service.name, k8s.namespace.name, k8s.pod.name, span.status.code, trace.id
| sort duration desc
| limit ${limit}`;
}

export function dqlGetTrace(bounds: TimeBounds, traceId: string, limit = 50): string {
  const cap = Math.min(Math.max(limit, 1), 100);
  return `fetch spans, ${fetchTimeClause(bounds)}
| filter trace.id == ${dqlString(traceId)} or dt.trace_id == ${dqlString(traceId)} or trace_id == ${dqlString(traceId)}
| fields timestamp, trace.id, span.id, span.name, span.kind, duration, k8s.namespace.name, k8s.pod.name, service.name, span.status.code
| sort timestamp asc
| limit ${cap}`;
}

export function dqlEntityByName(entityType: string, nameFilter: string): string {
  const type = entityType.startsWith("dt.entity.") ? entityType : `dt.entity.${entityType}`;
  return `fetch ${type}
| filter contains(entity.name, ${dqlString(nameFilter)}, caseSensitive:false)
| fields id, entity.name
| limit 25`;
}

export function dqlEntityById(entityType: string, entityId: string): string {
  const type = entityType.startsWith("dt.entity.") ? entityType : `dt.entity.${entityType}`;
  return `fetch ${type}
| filter id == ${dqlString(entityId)}
| fields id, entity.name
| limit 5`;
}
