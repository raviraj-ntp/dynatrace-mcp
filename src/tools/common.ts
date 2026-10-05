/**
 * @raviraj87/dynatrace-mcp · tools/common.ts
 * Shared tool schemas and JSON responses.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ConnectionManager, DynatraceClient } from "../client.js";
import { sanitizeRecords } from "../redact.js";
import { resolveTime, type TimeInput } from "../time.js";
import type { GrailQueryResult, LogFilterInput } from "../types.js";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ error: message });
}

export const connectionField = z
  .string()
  .optional()
  .describe("Named connection from env (default, optional stage/prod aliases, or a DYNATRACE_CONNECTIONS key)");

export const k8sClusterField = z
  .string()
  .optional()
  .describe("Dynatrace k8s.cluster.name. Discover with dynatrace_list_clusters; do not assume a cluster.");
export const k8sNamespaceField = z
  .string()
  .optional()
  .describe("Kubernetes namespace (k8s.namespace.name). Discover with dynatrace_list_namespaces.");
export const k8sWorkloadField = z
  .string()
  .optional()
  .describe("Workload or deployment name (k8s.workload.name / k8s.deployment.name).");
export const k8sPodField = z
  .string()
  .optional()
  .describe("Pod name: exact replica, prefix ending with '-', or glob (my-app-*).");

export const timeFields = {
  from: z.string().optional().describe("Start: now-30m or ISO-8601"),
  to: z.string().optional().describe("End: now or ISO-8601"),
  startDate: z.string().optional().describe("Calendar start YYYY-MM-DD (UTC day)"),
  endDate: z.string().optional().describe("Calendar end YYYY-MM-DD (UTC day)"),
  around: z.string().optional().describe("Pivot timestamp for a window"),
  window: z.string().optional().describe("Half-window around pivot, e.g. 2m"),
  allowLongRange: z.boolean().optional().describe("Allow ranges longer than the default cap"),
};

export const logScopeFields = {
  cluster: k8sClusterField,
  namespace: k8sNamespaceField,
  workload: k8sWorkloadField,
  pod: k8sPodField,
  pods: z.array(z.string()).optional().describe("One or more pod names (same matching rules as pod)"),
  container: z.string().optional().describe("k8s.container.name"),
  node: z.string().optional().describe("k8s.node.name"),
  host: z.string().optional().describe("host.name"),
  service: z.string().optional().describe("service.name / dt.entity.service"),
  entityId: z.string().optional().describe("Dynatrace entity id if known"),
};

export const logMatchFields = {
  loglevel: z.union([z.string(), z.array(z.string())]).optional().describe("ERROR,WARN or array"),
  excludeLevels: z.union([z.string(), z.array(z.string())]).optional(),
  contains: z.string().optional(),
  containsAll: z.array(z.string()).optional(),
  containsAny: z.array(z.string()).optional(),
  notContains: z.string().optional(),
  regex: z.string().optional(),
  caseInsensitive: z.boolean().optional(),
  status: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  excludePatterns: z.array(z.string()).optional(),
  sample: z.number().int().min(2).max(1000).optional().describe("Keep 1 in N lines"),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().min(0).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
  maxContentChars: z.number().int().positive().max(20_000).optional(),
};

export const logFilterFields = {
  ...logScopeFields,
  ...logMatchFields,
};

export function timeFromArgs(args: TimeInput, maxRangeMs?: number) {
  return resolveTime({ ...args, maxRangeMs: args.maxRangeMs ?? maxRangeMs });
}

export function boundsFromArgs(args: TimeInput, defaultFrom = "now-30m", maxRangeMs?: number) {
  return resolveTime({
    ...args,
    from: args.from ?? defaultFrom,
    maxRangeMs: args.maxRangeMs ?? maxRangeMs,
  });
}

export function logFilterFromArgs(args: LogFilterInput): LogFilterInput {
  return args;
}

export function mergeLogFilter(base: object, extra: LogFilterInput): LogFilterInput {
  return { ...(base as LogFilterInput), ...extra };
}

export function presentQuery(result: GrailQueryResult, maxContentChars = 2000) {
  return {
    records: sanitizeRecords(result.records, maxContentChars),
    recordCount: result.records.length,
    scannedBytes: result.scannedBytes,
    scannedRecords: result.scannedRecords,
    budgetUsedBytes: result.budgetUsedBytes,
    budgetLimitBytes: result.budgetLimitBytes,
    query: result.query,
  };
}

export function clientOf(manager: ConnectionManager, connection?: string): DynatraceClient {
  return manager.get(connection);
}

export async function runDql(
  manager: ConnectionManager,
  connection: string | undefined,
  dql: string,
  maxResultRecords?: number,
): Promise<GrailQueryResult> {
  return manager.get(connection).executeDql(dql, { maxResultRecords });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
