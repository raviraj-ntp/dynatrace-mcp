/**
 * @raviraj87/dynatrace-mcp · types.ts
 * Shared Dynatrace MCP types.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

export type ConnectionConfig = {
  name: string;
  url: string;
  apiToken: string;
  verifySsl: boolean;
};

export type AppConfig = {
  connections: ConnectionConfig[];
  defaultConnection: string;
  grailBudgetBytes: number;
};

export type TimeBounds = {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
};

export type LogFilterInput = {
  cluster?: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  pods?: string[];
  container?: string;
  node?: string;
  host?: string;
  service?: string;
  entityId?: string;
  loglevel?: string[] | string;
  excludeLevels?: string[] | string;
  contains?: string;
  containsAll?: string[];
  containsAny?: string[];
  notContains?: string;
  regex?: string;
  caseInsensitive?: boolean;
  status?: string;
  traceId?: string;
  spanId?: string;
  excludePatterns?: string[];
  sample?: number;
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
  maxContentChars?: number;
};

export type GrailQueryResult = {
  records: Record<string, unknown>[];
  scannedBytes: number;
  scannedRecords?: number;
  query?: string;
  budgetUsedBytes: number;
  budgetLimitBytes: number;
  types?: unknown;
};
