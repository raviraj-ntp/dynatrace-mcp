/**
 * @raviraj87/dynatrace-mcp · dql/security.ts
 * Security, vulnerability, and compliance DQL templates.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { TimeBounds } from "../types.js";
import { fetchTimeClause } from "../time.js";
import { dqlString } from "./escape.js";

export function dqlSecurityEventsSummary(bounds: TimeBounds, extraFilter?: string): string {
  const filter = extraFilter?.trim() ? `\n${extraFilter.trim()}` : "";
  return `fetch security.events, ${fetchTimeClause(bounds)}${filter}
| summarize findingCount=count(), by:{event.provider, event.type, dt.security.risk.level}
| sort findingCount desc
| limit 100`;
}

export function dqlVulnerabilities(bounds: TimeBounds, extraFilter?: string): string {
  const filter = extraFilter?.trim() ? `\n${extraFilter.trim()}` : "";
  return `fetch security.events, ${fetchTimeClause(bounds)}
| filter event.type == "VULNERABILITY_FINDING" or contains(event.type, "VULN")${filter}
| summarize count=count(), by:{dt.security.risk.level, finding.title, vulnerability.display_id}
| sort count desc
| limit 100`;
}

export function dqlComplianceFindings(bounds: TimeBounds, extraFilter?: string): string {
  const filter = extraFilter?.trim() ? `\n${extraFilter.trim()}` : "";
  return `fetch security.events, ${fetchTimeClause(bounds)}
| filter event.type == "COMPLIANCE_FINDING" or contains(event.type, "COMPLIANCE")${filter}
| summarize count=count(), by:{compliance.result.status.level, compliance.rule.severity.level, compliance.standard.short_name}
| sort count desc
| limit 100`;
}

export function dqlMetricsTimeseries(metric: string, bounds: TimeBounds, by?: string, filter?: string): string {
  const byClause = by?.trim() ? `, by:{${by}}` : "";
  const filterClause = filter?.trim() ? `\n${filter.trim()}` : "";
  return `timeseries avg(${metric})${byClause}, ${fetchTimeClause(bounds)}${filterClause}`;
}

export function dqlVerifyPassthrough(dql: string): string {
  return dql.trim();
}

export function extraEntityFilter(entityIdsOrNames?: string): string | undefined {
  if (!entityIdsOrNames || entityIdsOrNames.toUpperCase() === "ALL") return undefined;
  const parts = entityIdsOrNames
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  const ors = parts
    .map((p) => `contains(affected_entity.names, ${dqlString(p)}) or contains(object.name, ${dqlString(p)}) or contains(object.id, ${dqlString(p)})`)
    .join(" or ");
  return `| filter ${ors}`;
}
