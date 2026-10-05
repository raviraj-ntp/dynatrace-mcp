/**
 * @raviraj87/dynatrace-mcp · dql/logs.ts
 * Log DQL templates for summary, exact search, surround, and tail.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { LogFilterInput, TimeBounds } from "../types.js";
import { fetchTimeClause } from "../time.js";
import { andFilters, asList, dqlString, eqField, k8sPodFilter, k8sWorkloadFilter, orEq } from "./escape.js";

export function logScopeFilters(f: LogFilterInput): string {
  const pods = f.pods?.length ? f.pods : f.pod ? [f.pod] : [];
  const podFilter =
    pods.length > 1
      ? `(${pods
          .map((p) => k8sPodFilter(p) ?? "")
          .filter(Boolean)
          .join(" or ")})`
      : k8sPodFilter(pods[0]);

  const levels = asList(f.loglevel);
  const exclude = asList(f.excludeLevels);
  const insen = f.caseInsensitive !== false;
  const containsOpts = insen ? ", caseSensitive:false" : "";

  const text: string[] = [];
  if (f.contains) text.push(`contains(content, ${dqlString(f.contains)}${containsOpts})`);
  for (const part of f.containsAll ?? []) {
    text.push(`contains(content, ${dqlString(part)}${containsOpts})`);
  }
  if (f.containsAny?.length) {
    text.push(
      `(${f.containsAny.map((p) => `contains(content, ${dqlString(p)}${containsOpts})`).join(" or ")})`,
    );
  }
  if (f.notContains) text.push(`not contains(content, ${dqlString(f.notContains)}${containsOpts})`);
  if (f.regex) text.push(`matches(content, ${dqlString(f.regex)})`);
  for (const pat of f.excludePatterns ?? []) {
    text.push(`not contains(content, ${dqlString(pat)}${containsOpts})`);
  }

  return andFilters([
    eqField("k8s.cluster.name", f.cluster),
    eqField("k8s.namespace.name", f.namespace),
    k8sWorkloadFilter(f.workload, ["k8s.workload.name", "k8s.deployment.name"]),
    podFilter,
    eqField("k8s.container.name", f.container),
    eqField("k8s.node.name", f.node),
    eqField("host.name", f.host),
    eqField("dt.entity.service", f.entityId) ?? eqField("service.name", f.service),
    orEq("loglevel", levels),
    exclude.length ? `not (${exclude.map((l) => `loglevel == ${dqlString(l)}`).join(" or ")})` : undefined,
    f.status ? `status == ${dqlString(f.status)} or status.code == ${dqlString(f.status)}` : undefined,
    eqField("trace_id", f.traceId) ?? eqField("dt.trace_id", f.traceId),
    eqField("span_id", f.spanId),
    ...text,
  ]);
}

function sampleClause(sample?: number): string {
  if (!sample || sample <= 1) return "";
  return `| filter hash64(content) % ${Math.floor(sample)} == 0`;
}

function sortLimit(f: LogFilterInput, defaultLimit: number): string {
  const limit = Math.min(Math.max(f.limit ?? defaultLimit, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const dir = f.sort === "asc" ? "asc" : "desc";
  const skip = offset > 0 ? `\n| skip ${offset}` : "";
  return `| sort timestamp ${dir}${skip}\n| limit ${limit}`;
}

const LOG_FIELDS =
  "timestamp, loglevel, status, content, k8s.cluster.name, k8s.namespace.name, k8s.pod.name, k8s.container.name, k8s.workload.name, k8s.node.name, trace_id, dt.trace_id, span_id, host.name";

export function dqlSearchLogs(bounds: TimeBounds, f: LogFilterInput): string {
  return `fetch logs, ${fetchTimeClause(bounds)}
${logScopeFilters(f)}
${sampleClause(f.sample)}
| fields ${LOG_FIELDS}
${sortLimit(f, 50)}`;
}

export function dqlLogSummary(bounds: TimeBounds, f: LogFilterInput): string {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 200);
  return `fetch logs, ${fetchTimeClause(bounds)}
${logScopeFilters(f)}
| summarize count=count(), by:{loglevel, k8s.namespace.name, k8s.pod.name, k8s.container.name}
| sort count desc
| limit ${limit}`;
}

export function dqlSurrounding(
  bounds: TimeBounds,
  f: LogFilterInput,
  extraLimit = 100,
): string {
  return `fetch logs, ${fetchTimeClause(bounds)}
${logScopeFilters(f)}
| fields ${LOG_FIELDS}
| sort timestamp asc
| limit ${Math.min(extraLimit, 200)}`;
}

export function dqlPodLogs(bounds: TimeBounds, f: LogFilterInput): string {
  return dqlSearchLogs(bounds, f);
}

export function dqlExceptions(bounds: TimeBounds, f: LogFilterInput): string {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  return `fetch logs, ${fetchTimeClause(bounds)}
${logScopeFilters(f)}
| filter isNotNull(exception.message) or isNotNull(exception.type) or contains(content, "Exception") or loglevel == "ERROR"
| fields timestamp, loglevel, exception.type, exception.message, k8s.namespace.name, k8s.pod.name, k8s.container.name, content
| sort timestamp desc
| limit ${limit}`;
}
