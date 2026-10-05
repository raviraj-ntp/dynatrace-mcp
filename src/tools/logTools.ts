/**
 * @raviraj87/dynatrace-mcp · tools/logTools.ts
 * Log summary, exact search, surrounding context, tail, and wait-for-pattern.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../client.js";
import { dqlLogSummary, dqlPodLogs, dqlSearchLogs, dqlSurrounding } from "../dql/logs.js";
import { iso, parseInstant, parseWindow, resolveTime } from "../time.js";
import {
  connectionField,
  errorResult,
  jsonResult,
  logFilterFields,
  logMatchFields,
  logFilterFromArgs,
  mergeLogFilter,
  presentQuery,
  runDql,
  sleep,
  timeFields,
  boundsFromArgs,
} from "./common.js";

export function registerLogTools(server: McpServer, manager: ConnectionManager): void {
  server.registerTool(
    "dynatrace_log_summary",
    {
      title: "Log Summary",
      description:
        "Count logs by level, namespace, pod, and container. Call this before fetching raw lines. Requires date/time bounds.",
      inputSchema: { connection: connectionField, ...timeFields, ...logFilterFields },
    },
    async ({ connection, ...args }) => {
      try {
        const bounds = boundsFromArgs(args, "now-30m");
        const result = await runDql(manager, connection, dqlLogSummary(bounds, logFilterFromArgs(args)), args.limit ?? 100);
        return jsonResult({ bounds, ...presentQuery(result, 400) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_search_logs",
    {
      title: "Search Logs",
      description:
        "Exact matching log lines only (not a dump). Filter by cluster/namespace/pod/container, loglevel, contains/regex, trace id, and date bounds. Default limit 50, max 200.",
      inputSchema: { connection: connectionField, ...timeFields, ...logFilterFields },
    },
    async ({ connection, ...args }) => {
      try {
        const bounds = boundsFromArgs(args, "now-30m");
        const result = await runDql(manager, connection, dqlSearchLogs(bounds, logFilterFromArgs(args)), args.limit ?? 50);
        const presented = presentQuery(result, args.maxContentChars ?? 2000);
        const timestamps = result.records
          .map((r) => r.timestamp)
          .filter((t) => t != null)
          .slice(0, 20);
        return jsonResult({ bounds, matchTimestamps: timestamps, ...presented });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_logs_surrounding",
    {
      title: "Surrounding Logs",
      description:
        "Lines around a pivot timestamp for the same pod/container (grep -C in time). before/after default 30s, max 5m.",
      inputSchema: {
        connection: connectionField,
        pivot: z.string().min(1).describe("ISO timestamp of a matching log line"),
        before: z.string().optional().describe("e.g. 30s"),
        after: z.string().optional().describe("e.g. 30s"),
        ...timeFields,
        ...logFilterFields,
      },
    },
    async ({ connection, pivot, before, after, ...args }) => {
      try {
        const beforeMs = parseWindow(before, 30_000);
        const afterMs = parseWindow(after, 30_000);
        const cap = 5 * 60_000;
        const pivotMs = parseInstant(pivot);
        const fromMs = pivotMs - Math.min(beforeMs, cap);
        const toMs = pivotMs + Math.min(afterMs, cap);
        const outer = resolveTime({ from: args.from, to: args.to, startDate: args.startDate, endDate: args.endDate, allowLongRange: args.allowLongRange });
        const bounds = {
          from: iso(Math.max(fromMs, outer.fromMs)),
          to: iso(Math.min(toMs, outer.toMs)),
          fromMs: Math.max(fromMs, outer.fromMs),
          toMs: Math.min(toMs, outer.toMs),
        };
        if (bounds.fromMs >= bounds.toMs) {
          throw new Error("Surrounding window is empty after applying outer date bounds");
        }
        const result = await runDql(manager, connection, dqlSurrounding(bounds, logFilterFromArgs(args)), 200);
        return jsonResult({ bounds, pivot, ...presentQuery(result, args.maxContentChars ?? 2000) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_pod_logs",
    {
      title: "Pod Logs",
      description: "Last N log lines for a pod (still time-bounded). Prefer log_summary / search_logs for filters.",
      inputSchema: {
        connection: connectionField,
        ...timeFields,
        ...logFilterFields,
        pod: z.string().min(1),
      },
    },
    async ({ connection, pod, namespace, cluster, container, ...args }) => {
      try {
        const bounds = boundsFromArgs(args, "now-30m");
        const filter = mergeLogFilter(args, { pod, namespace, cluster, container });
        const result = await runDql(manager, connection, dqlPodLogs(bounds, filter), args.limit ?? 50);
        return jsonResult({ bounds, ...presentQuery(result, args.maxContentChars ?? 2000) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_logs_tail",
    {
      title: "Tail Logs",
      description:
        "Polling live tail for one or more pods. Pass since from the previous nextSince. First call defaults to now-30s. Not a websocket; poll from the agent.",
      inputSchema: {
        connection: connectionField,
        pods: z.array(z.string()).min(1).max(20),
        namespace: z.string().optional(),
        cluster: z.string().optional(),
        container: z.string().optional(),
        since: z.string().optional().describe("ISO timestamp cursor from previous nextSince"),
        ...logMatchFields,
      },
    },
    async ({ connection, pods, namespace, cluster, container, since, ...args }) => {
      try {
        const now = Date.now();
        const sinceMs = since ? parseInstant(since, now) : now - 30_000;
        const maxWindow = 2 * 60_000;
        const fromMs = Math.max(sinceMs, now - maxWindow);
        const bounds = { from: iso(fromMs), to: iso(now), fromMs, toMs: now };
        const filter = mergeLogFilter(args, {
          pods,
          namespace,
          cluster,
          container,
          sort: "asc",
          limit: Math.min(args.limit ?? 100, 100),
        });
        const result = await runDql(manager, connection, dqlSearchLogs(bounds, filter), filter.limit ?? 100);
        const lastTs = result.records.reduce((acc, row) => {
          const t = row.timestamp;
          const ms = typeof t === "number" ? t : t ? Date.parse(String(t)) : NaN;
          return Number.isFinite(ms) && ms > acc ? ms : acc;
        }, fromMs);
        const nextSince = iso(Math.max(lastTs, now - 1000));
        return jsonResult({
          bounds,
          nextSince,
          newCount: result.records.length,
          ...presentQuery(result, args.maxContentChars ?? 2000),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "dynatrace_logs_wait",
    {
      title: "Wait For Log Pattern",
      description:
        "Poll until contains/regex appears on the given pods or timeout (default 30s, max 120s). For integration tests.",
      inputSchema: {
        connection: connectionField,
        pods: z.array(z.string()).min(1).max(20),
        namespace: z.string().optional(),
        cluster: z.string().optional(),
        container: z.string().optional(),
        timeoutSeconds: z.number().int().positive().max(120).optional(),
        ...logMatchFields,
      },
    },
    async ({ connection, pods, namespace, cluster, container, contains, regex, timeoutSeconds, ...args }) => {
      try {
        const pattern = contains || regex;
        if (!pattern) throw new Error("Provide contains or regex to wait for");
        const timeoutMs = Math.min((timeoutSeconds ?? 30) * 1000, 120_000);
        const started = Date.now();
        let sinceMs = started - 15_000;
        while (Date.now() - started < timeoutMs) {
          const now = Date.now();
          const bounds = { from: iso(sinceMs), to: iso(now), fromMs: sinceMs, toMs: now };
          const filter = mergeLogFilter(args, {
            pods,
            namespace,
            cluster,
            container,
            contains,
            regex,
            sort: "desc",
            limit: 20,
          });
          const result = await runDql(manager, connection, dqlSearchLogs(bounds, filter), 20);
          if (result.records.length) {
            const hit = result.records[0];
            const pivot = String(hit.timestamp ?? iso(now));
            const surroundFrom = parseInstant(pivot) - 5000;
            const surroundTo = parseInstant(pivot) + 5000;
            const surroundBounds = {
              from: iso(surroundFrom),
              to: iso(surroundTo),
              fromMs: surroundFrom,
              toMs: surroundTo,
            };
            const around = await runDql(
              manager,
              connection,
              dqlSurrounding(surroundBounds, { ...filter, contains: undefined, regex: undefined }),
              50,
            );
            return jsonResult({
              matched: true,
              waitedMs: Date.now() - started,
              hit: presentQuery(result, args.maxContentChars ?? 2000),
              surrounding: presentQuery(around, args.maxContentChars ?? 2000),
            });
          }
          sinceMs = now - 2000;
          await sleep(2000);
        }
        return jsonResult({ matched: false, waitedMs: Date.now() - started, timeoutSeconds: timeoutMs / 1000 });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
