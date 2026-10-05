/**
 * @raviraj87/dynatrace-mcp · client.ts
 * Dynatrace Platform Grail query client and Environment API helper.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import https from "node:https";
import fetch, { type Response as FetchResponse } from "node-fetch";
import type { AppConfig, ConnectionConfig, GrailQueryResult } from "./types.js";

const POLL_MS = 400;
const POLL_MAX = 90;

export class GrailBudget {
  usedBytes = 0;
  constructor(public readonly limitBytes: number) {}

  add(bytes: number): void {
    this.usedBytes += Math.max(0, bytes);
    if (this.usedBytes > this.limitBytes) {
      throw new Error(
        `Grail query budget exceeded (${(this.usedBytes / 1e9).toFixed(2)} GB of ${(this.limitBytes / 1e9).toFixed(0)} GB). Call dynatrace_reset_grail_budget or raise DYNATRACE_GRAIL_QUERY_BUDGET_GB.`,
      );
    }
  }

  reset(): void {
    this.usedBytes = 0;
  }

  snapshot() {
    return { usedBytes: this.usedBytes, limitBytes: this.limitBytes, usedGb: this.usedBytes / 1e9 };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readScannedBytes(body: Record<string, unknown>): number {
  const meta = asRecord(body.metadata);
  const grail = asRecord(meta.grail);
  const result = asRecord(body.result);
  const resultMeta = asRecord(result.metadata);
  const resultGrail = asRecord(resultMeta.grail);
  const n =
    Number(grail.scannedBytes ?? resultGrail.scannedBytes ?? body.scannedBytes ?? result.scannedBytes ?? 0) || 0;
  return n;
}

function readRecords(body: Record<string, unknown>): Record<string, unknown>[] {
  const result = asRecord(body.result);
  const records = result.records ?? body.records;
  if (!Array.isArray(records)) return [];
  return records.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
}

function requestTokenFrom(resp: FetchResponse, body: Record<string, unknown>): string | undefined {
  const header =
    resp.headers.get("dt-request-token") ??
    resp.headers.get("request-token") ??
    resp.headers.get("Dt-Request-Token") ??
    undefined;
  const nested = asRecord(body.result);
  const token = header ?? body.requestToken ?? body.request_token ?? nested.requestToken;
  return typeof token === "string" && token ? token : undefined;
}

export class DynatraceClient {
  private readonly agent: https.Agent;

  constructor(
    private readonly conn: ConnectionConfig,
    private readonly budget: GrailBudget,
  ) {
    this.agent = new https.Agent({ rejectUnauthorized: conn.verifySsl });
  }

  get name(): string {
    return this.conn.name;
  }

  get url(): string {
    return this.conn.url;
  }

  get budgetTracker(): GrailBudget {
    return this.budget;
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Api-Token ${this.conn.apiToken}`,
      Accept: "application/json",
    };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  private async parseBody(resp: FetchResponse): Promise<unknown> {
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async rest(method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<unknown> {
    const url = new URL(path.replace(/^\//, "/"), `${this.conn.url}/`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url.toString(), {
      method,
      headers: this.headers(body ? "application/json" : undefined),
      body: body ? JSON.stringify(body) : undefined,
      agent: this.agent,
    });
    const parsed = await this.parseBody(resp);
    if (!resp.ok) {
      throw new Error(`Dynatrace ${method} ${url.pathname} HTTP ${resp.status}: ${JSON.stringify(parsed).slice(0, 1500)}`);
    }
    return parsed;
  }

  async executeDql(
    dql: string,
    opts: { maxResultRecords?: number; includeTypes?: boolean; requestTimeoutMs?: number } = {},
  ): Promise<GrailQueryResult> {
    const maxResultRecords = Math.min(Math.max(opts.maxResultRecords ?? 200, 1), 1000);
    const payload = {
      query: dql,
      maxResultRecords,
      requestTimeoutMilliseconds: opts.requestTimeoutMs ?? 60_000,
      fetchTimeoutSeconds: 60,
    };

    const url = new URL("platform/storage/query/v1/query:execute", `${this.conn.url}/`);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(payload),
      agent: this.agent,
    });
    let body = asRecord(await this.parseBody(resp));
    if (!resp.ok && resp.status !== 202) {
      throw new Error(`Grail query:execute HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 2000)}`);
    }

    let token = requestTokenFrom(resp, body);
    const state = String(body.state ?? asRecord(body.result).state ?? "").toUpperCase();
    const finished = ["SUCCEEDED", "FINISHED", "DONE"].includes(state);
    if (token && !finished && (resp.status === 202 || state === "RUNNING" || state === "PENDING" || (!readRecords(body).length && resp.status !== 200))) {
      body = await this.poll(token, opts.requestTimeoutMs ?? 60_000);
    }

    const scannedBytes = readScannedBytes(body);
    this.budget.add(scannedBytes);
    const records = readRecords(body);
    return {
      records,
      scannedBytes,
      scannedRecords: Number(asRecord(asRecord(body.metadata).grail).scannedRecords ?? records.length) || records.length,
      query: dql,
      budgetUsedBytes: this.budget.usedBytes,
      budgetLimitBytes: this.budget.limitBytes,
      types: opts.includeTypes === false ? undefined : asRecord(body.metadata).types ?? asRecord(asRecord(body.result).metadata).types,
    };
  }

  private async poll(requestToken: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < POLL_MAX && Date.now() < deadline; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const url = new URL("platform/storage/query/v1/query:poll", `${this.conn.url}/`);
      url.searchParams.set("request-token", requestToken);
      url.searchParams.set("request-timeout-milliseconds", "30000");
      const resp = await fetch(url.toString(), { method: "GET", headers: this.headers(), agent: this.agent });
      const body = asRecord(await this.parseBody(resp));
      if (!resp.ok && resp.status !== 202) {
        throw new Error(`Grail query:poll HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 1500)}`);
      }
      const state = String(body.state ?? asRecord(body.result).state ?? "").toUpperCase();
      if (state === "FAILED" || state === "ERROR" || state === "CANCELLED") {
        throw new Error(`Grail query ${state}: ${JSON.stringify(body).slice(0, 1500)}`);
      }
      if (["SUCCEEDED", "FINISHED", "DONE"].includes(state) || (resp.status === 200 && state !== "RUNNING" && state !== "PENDING")) {
        return body;
      }
    }
    throw new Error("Grail query timed out while polling");
  }

  async parseDql(dql: string): Promise<unknown> {
    const url = new URL("platform/storage/query/v1/query:parse", `${this.conn.url}/`);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ query: dql }),
      agent: this.agent,
    });
    const body = await this.parseBody(resp);
    if (!resp.ok) {
      throw new Error(`Grail query:parse HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 1500)}`);
    }
    return body;
  }

  async metricsQuery(metricSelector: string, from: string, to: string): Promise<unknown> {
    return this.rest("GET", "/api/v2/metrics/query", { metricSelector, from, to });
  }
}

export class ConnectionManager {
  private readonly clients = new Map<string, DynatraceClient>();
  readonly budget: GrailBudget;
  readonly defaultName: string;

  constructor(config: AppConfig) {
    this.budget = new GrailBudget(config.grailBudgetBytes);
    this.defaultName = config.defaultConnection;
    for (const conn of config.connections) {
      this.clients.set(conn.name, new DynatraceClient(conn, this.budget));
    }
  }

  list(): { name: string; url: string; default: boolean }[] {
    return [...this.clients.values()].map((c) => ({
      name: c.name,
      url: c.url,
      default: c.name === this.defaultName,
    }));
  }

  get(name?: string): DynatraceClient {
    const key = name?.trim() || this.defaultName;
    const client = this.clients.get(key);
    if (!client) {
      throw new Error(`Unknown connection '${key}'. Known: ${[...this.clients.keys()].join(", ")}`);
    }
    return client;
  }
}
