/**
 * @raviraj87/dynatrace-mcp · dql/problems.ts
 * Davis problems DQL templates.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { TimeBounds } from "../types.js";
import { fetchTimeClause } from "../time.js";
import { dqlString } from "./escape.js";

export function dqlQueryProblems(
  bounds: TimeBounds,
  status?: string,
  limit = 200,
  search?: string,
): string {
  const cap = Math.min(Math.max(limit, 1), 200);
  const statusFilter =
    !status || status.toUpperCase() === "ALL"
      ? ""
      : `| filter event.status == ${dqlString(status.toUpperCase())}`;
  const searchFilter = search?.trim()
    ? `| filter contains(event.description, ${dqlString(search.trim())}, caseSensitive:false) or contains(display_id, ${dqlString(search.trim())}, caseSensitive:false) or contains(event.category, ${dqlString(search.trim())}, caseSensitive:false)`
    : "";
  return `fetch dt.davis.problems, ${fetchTimeClause(bounds)}
| fields event.id, display_id, event.status, event.start, event.end, event.category, event.description, affected_entity_ids, related_entity_ids
${statusFilter}
${searchFilter}
| sort event.start desc
| limit ${cap}`;
}

export function dqlGetProblem(bounds: TimeBounds, problemId: string): string {
  const id = problemId.trim();
  return `fetch dt.davis.problems, ${fetchTimeClause(bounds)}
| fields event.id, display_id, event.status, event.start, event.end, event.category, event.description, affected_entity_ids, related_entity_ids
| filter display_id == ${dqlString(id)} or event.id == ${dqlString(id)} or contains(event.id, ${dqlString(id)}) or contains(display_id, ${dqlString(id)})
| sort event.start desc
| limit 5`;
}

export function extractProblemId(text: string): string | undefined {
  const m = text.match(/\bP-\d+\b/i);
  if (m) return m[0].toUpperCase();
  const numeric = text.match(/\b\d{3,}_\d+/);
  return numeric?.[0];
}

/** Best-effort names from alert text. Never a substitute for list_clusters / list_namespaces. */
export function extractK8sHints(text: string): {
  cluster?: string;
  namespace?: string;
  pod?: string;
  workload?: string;
} {
  const namespace =
    text.match(/\bnamespace[:\s=]+([a-z0-9][a-z0-9-]*)/i)?.[1] ??
    text.match(/\bns[:\s=]+([a-z0-9][a-z0-9-]*)/i)?.[1];
  const cluster = text.match(/\bcluster[:\s=]+([a-z0-9][a-z0-9._-]*)/i)?.[1];
  const workload = text.match(/\b(?:deployment|workload|statefulset|daemonset)[:\s=]+([a-z0-9][a-z0-9-]*)/i)?.[1];
  const pod = text.match(/\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-z0-9]{4,10}-[a-z0-9]{4,10})\b/)?.[1];
  return { cluster, namespace, pod, workload };
}
