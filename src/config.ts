/**
 * @raviraj87/dynatrace-mcp · config.ts
 * Environment configuration loader with named connections.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { AppConfig, ConnectionConfig } from "./types.js";

function envFlag(name: string, defaultValue = false): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return defaultValue;
  const normalized = v.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function stripUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeToken(raw: string): string {
  return raw
    .trim()
    .replace(/^Api-Token\s+/i, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function tokenFrom(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) return normalizeToken(v);
  }
  return undefined;
}

function addConnection(
  list: ConnectionConfig[],
  name: string,
  url: string | undefined,
  token: string | undefined,
  verifySsl: boolean,
): void {
  if (!url || !token) return;
  list.push({ name, url: stripUrl(url), apiToken: normalizeToken(token), verifySsl });
}

export function loadConfig(): AppConfig {
  const verifySsl = !envFlag("DYNATRACE_NO_SSL_VERIFY");
  const connections: ConnectionConfig[] = [];

  const defaultUrl = process.env.DYNATRACE_URL?.trim() || process.env.DT_ENVIRONMENT?.trim();
  const defaultToken = tokenFrom(["DYNATRACE_API_TOKEN", "DT_PLATFORM_TOKEN", "DYNATRACE_TOKEN"]);
  addConnection(connections, "default", defaultUrl, defaultToken, verifySsl);

  addConnection(
    connections,
    "stage",
    process.env.DYNATRACE_STAGE_URL,
    tokenFrom(["DYNATRACE_STAGE_TOKEN", "DYNATRACE_STAGE_API_TOKEN"]),
    verifySsl,
  );
  addConnection(
    connections,
    "prod",
    process.env.DYNATRACE_PROD_URL,
    tokenFrom(["DYNATRACE_PROD_TOKEN", "DYNATRACE_PROD_API_TOKEN"]),
    verifySsl,
  );

  const extra = process.env.DYNATRACE_CONNECTIONS?.trim();
  if (extra) {
    const parsed = JSON.parse(extra) as Record<string, { url?: string; token?: string }>;
    for (const [name, entry] of Object.entries(parsed)) {
      addConnection(connections, name, entry.url, entry.token, verifySsl);
    }
  }

  if (!connections.length) {
    throw new Error(
      "Missing Dynatrace connection. Set DYNATRACE_URL and DYNATRACE_API_TOKEN (or DT_ENVIRONMENT and DT_PLATFORM_TOKEN).",
    );
  }

  const namedDefault = process.env.DYNATRACE_DEFAULT_CONNECTION?.trim();
  const defaultConnection =
    namedDefault && connections.some((c) => c.name === namedDefault) ? namedDefault : connections[0].name;

  const budgetGb = Number(process.env.DYNATRACE_GRAIL_QUERY_BUDGET_GB ?? process.env.DT_GRAIL_QUERY_BUDGET_GB ?? "1000");
  const grailBudgetBytes = (Number.isFinite(budgetGb) && budgetGb > 0 ? budgetGb : 1000) * 1024 * 1024 * 1024;

  return { connections, defaultConnection, grailBudgetBytes };
}
