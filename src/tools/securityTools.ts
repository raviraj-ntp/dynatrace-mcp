/**
 * @raviraj87/dynatrace-mcp · tools/securityTools.ts
 * Security events, vulnerabilities, compliance summaries, and metrics.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../client.js";
import {
  dqlComplianceFindings,
  dqlMetricsTimeseries,
  dqlSecurityEventsSummary,
  dqlVulnerabilities,
  extraEntityFilter,
} from "../dql/security.js";
import {
  clientOf,
  connectionField,
  errorResult,
  jsonResult,
  presentQuery,
  runDql,
  timeFields,
  boundsFromArgs,
} from "./common.js";

export function registerSecurityTools(server: McpServer, manager: ConnectionManager): void {
  server.registerTool(
    "dynatrace_security_events_summary",
    {
      title: "Security Events Summary",
      description: "Summarize security.events by provider, type, and risk level. Always aggregated.",
      inputSchema: {
        connection: connectionField,
        entityIdsOrNames: z.string().optional(),
        extraFilter: z.string().optional().describe("Additional DQL | filter ..."),
        ...timeFields,
      },
    },
    async ({ connection, entityIdsOrNames, extraFilter, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h", 30 * 86_400_000);
        const extra = [extraEntityFilter(entityIdsOrNames), extraFilter].filter(Boolean).join("\n");
        const result = await runDql(manager, connection, dqlSecurityEventsSummary(bounds, extra || undefined), 100);
        return jsonResult({ bounds, ...presentQuery(result, 400) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_vulnerabilities",
    {
      title: "Vulnerabilities Summary",
      description: "Summarized vulnerability findings from Grail security.events (max 100 groups).",
      inputSchema: {
        connection: connectionField,
        entityIdsOrNames: z.string().optional(),
        extraFilter: z.string().optional(),
        ...timeFields,
      },
    },
    async ({ connection, entityIdsOrNames, extraFilter, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h", 30 * 86_400_000);
        const extra = [extraEntityFilter(entityIdsOrNames), extraFilter].filter(Boolean).join("\n");
        const result = await runDql(manager, connection, dqlVulnerabilities(bounds, extra || undefined), 100);
        return jsonResult({ bounds, ...presentQuery(result, 400) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_compliance_findings",
    {
      title: "Compliance Findings Summary",
      description: "Summarized compliance findings from Grail (aggregated, max 100).",
      inputSchema: {
        connection: connectionField,
        extraFilter: z.string().optional(),
        ...timeFields,
      },
    },
    async ({ connection, extraFilter, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-1h", 30 * 86_400_000);
        const result = await runDql(manager, connection, dqlComplianceFindings(bounds, extraFilter), 100);
        return jsonResult({ bounds, ...presentQuery(result, 400) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_metrics_query",
    {
      title: "Query Metrics",
      description: "Run a DQL timeseries or Environment API v2 metric selector within date bounds.",
      inputSchema: {
        connection: connectionField,
        metric: z.string().min(1).describe("Metric id, e.g. dt.kubernetes.container.cpu_usage"),
        by: z.string().optional().describe("DQL by fields, e.g. k8s.pod.name, k8s.namespace.name"),
        filter: z.string().optional().describe("Optional DQL | filter ..."),
        useClassicApi: z.boolean().optional().describe("If true, GET /api/v2/metrics/query"),
        ...timeFields,
      },
    },
    async ({ connection, metric, by, filter, useClassicApi, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-30m");
        if (useClassicApi) {
          const data = await clientOf(manager, connection).metricsQuery(metric, bounds.from, bounds.to);
          return jsonResult({ bounds, api: "v2", data });
        }
        const result = await runDql(manager, connection, dqlMetricsTimeseries(metric, bounds, by, filter), 200);
        return jsonResult({ bounds, ...presentQuery(result, 400) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
