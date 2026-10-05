/**
 * @raviraj87/dynatrace-mcp · tools/coreTools.ts
 * Health, DQL, problems, entities, and cluster events.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../client.js";
import { dqlEntityById, dqlEntityByName, dqlK8sEvents } from "../dql/k8s.js";
import { dqlExceptions } from "../dql/logs.js";
import { dqlGetProblem, dqlQueryProblems } from "../dql/problems.js";
import {
  clientOf,
  connectionField,
  errorResult,
  jsonResult,
  k8sClusterField,
  k8sNamespaceField,
  k8sPodField,
  k8sWorkloadField,
  logFilterFields,
  logFilterFromArgs,
  presentQuery,
  runDql,
  timeFields,
  boundsFromArgs,
  timeFromArgs,
} from "./common.js";

export function registerCoreTools(server: McpServer, manager: ConnectionManager): void {
  server.registerTool(
    "dynatrace_health",
    {
      title: "Dynatrace Health",
      description: "Check Dynatrace connectivity and Grail access for a named connection.",
      inputSchema: { connection: connectionField },
    },
    async ({ connection }) => {
      try {
        const client = clientOf(manager, connection);
        const result = await client.executeDql("fetch logs, from:now()-5m, to:now() | limit 1", { maxResultRecords: 1 });
        return jsonResult({
          ok: true,
          connection: client.name,
          url: client.url,
          grail: presentQuery(result, 200),
          budget: client.budgetTracker.snapshot(),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_list_connections",
    {
      title: "List Dynatrace Connections",
      description: "List configured named connections (default, stage, prod, ...).",
      inputSchema: {},
    },
    async () => jsonResult({ connections: manager.list() }),
  );

  server.registerTool(
    "dynatrace_reset_grail_budget",
    {
      title: "Reset Grail Budget",
      description: "Clear session Grail scanned-bytes budget so queries can continue.",
      inputSchema: {},
    },
    async () => {
      manager.budget.reset();
      return jsonResult({ ok: true, budget: manager.budget.snapshot() });
    },
  );

  server.registerTool(
    "dynatrace_execute_dql",
    {
      title: "Execute DQL",
      description: "Run a DQL query against Grail. Use templated tools when possible. Requires valid DQL, not natural language.",
      inputSchema: {
        connection: connectionField,
        dql: z.string().min(1),
        maxResultRecords: z.number().int().positive().max(1000).optional(),
        ...timeFields,
      },
    },
    async ({ connection, dql, maxResultRecords, ...time }) => {
      try {
        let query = dql;
        if (time.from || time.to || time.startDate || time.endDate) {
          const bounds = timeFromArgs(time, time.allowLongRange ? 90 * 86_400_000 : 7 * 86_400_000);
          if (!/\bfrom\s*:/.test(query)) {
            query = query.replace(
              /^(fetch\s+\S+)/i,
              `$1, from:"${bounds.from}", to:"${bounds.to}"`,
            );
          }
        }
        const result = await runDql(manager, connection, query, maxResultRecords);
        return jsonResult(presentQuery(result));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_verify_dql",
    {
      title: "Verify DQL",
      description: "Parse/verify a DQL statement without executing it against Grail storage.",
      inputSchema: { connection: connectionField, dql: z.string().min(1) },
    },
    async ({ connection, dql }) => {
      try {
        const parsed = await clientOf(manager, connection).parseDql(dql);
        return jsonResult({ ok: true, parsed });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_query_problems",
    {
      title: "Query Davis Problems",
      description: "List Davis problems. status: ACTIVE, CLOSED, or ALL. Optional search on description/id/category. Date bounds apply (default last 2h, max 30d).",
      inputSchema: {
        connection: connectionField,
        status: z.enum(["ACTIVE", "CLOSED", "ALL"]).optional(),
        limit: z.number().int().positive().max(200).optional(),
        search: z.string().optional().describe("Substring match on description, display_id, or category"),
        ...timeFields,
      },
    },
    async ({ connection, status, limit, search, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h", time.allowLongRange ? 90 * 86_400_000 : 30 * 86_400_000);
        const result = await runDql(manager, connection, dqlQueryProblems(bounds, status, limit, search), limit ?? 200);
        return jsonResult({ ...presentQuery(result, 4000), bounds });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_get_problem",
    {
      title: "Get Davis Problem",
      description: "Get a Davis problem by display id (P-123) or event id.",
      inputSchema: {
        connection: connectionField,
        problemId: z.string().min(1),
        ...timeFields,
      },
    },
    async ({ connection, problemId, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-7d", time.allowLongRange ? 90 * 86_400_000 : 30 * 86_400_000);
        const result = await runDql(manager, connection, dqlGetProblem(bounds, problemId), 5);
        return jsonResult({ ...presentQuery(result, 8000), bounds, problemId });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_list_exceptions",
    {
      title: "List Exceptions",
      description: "Recent ERROR/exception log lines. Use log filters and date bounds.",
      inputSchema: { connection: connectionField, ...timeFields, ...logFilterFields },
    },
    async ({ connection, ...args }) => {
      try {
        const bounds = boundsFromArgs(args, "now-2h");
        const result = await runDql(manager, connection, dqlExceptions(bounds, logFilterFromArgs(args)), args.limit ?? 50);
        return jsonResult({ ...presentQuery(result, args.maxContentChars ?? 2000), bounds });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_k8s_events",
    {
      title: "Kubernetes Events",
      description: "Kubernetes cluster/pod/workload events in a time range.",
      inputSchema: {
        connection: connectionField,
        cluster: k8sClusterField,
        namespace: k8sNamespaceField,
        pod: k8sPodField,
        workload: k8sWorkloadField,
        findAll: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
        ...timeFields,
      },
    },
    async ({ connection, cluster, namespace, pod, workload, findAll, limit, ...time }) => {
      try {
        const bounds = boundsFromArgs(time, "now-2h");
        const result = await runDql(
          manager,
          connection,
          dqlK8sEvents(bounds, { cluster, namespace, pod, workload, findAll, limit }),
          limit ?? 100,
        );
        return jsonResult({ ...presentQuery(result, 3000), bounds });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_get_entity_id",
    {
      title: "Get Entity ID",
      description: "Look up Dynatrace entity IDs by type (dt.entity.host, dt.entity.service, ...) and name substring.",
      inputSchema: {
        connection: connectionField,
        entityType: z.string().min(1),
        entityNameFilter: z.string().min(1),
      },
    },
    async ({ connection, entityType, entityNameFilter }) => {
      try {
        const result = await runDql(manager, connection, dqlEntityByName(entityType, entityNameFilter), 25);
        return jsonResult(presentQuery(result, 500));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_get_entity_name",
    {
      title: "Get Entity Name",
      description: "Resolve a Dynatrace entity ID to its display name.",
      inputSchema: {
        connection: connectionField,
        entityType: z.string().min(1),
        entityId: z.string().min(1),
      },
    },
    async ({ connection, entityType, entityId }) => {
      try {
        const result = await runDql(manager, connection, dqlEntityById(entityType, entityId), 5);
        return jsonResult(presentQuery(result, 500));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
