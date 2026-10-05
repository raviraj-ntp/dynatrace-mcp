/**
 * @raviraj87/dynatrace-mcp · time.ts
 * Resolve relative, ISO, and calendar date bounds for Grail queries.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { TimeBounds } from "./types.js";

const RELATIVE_RE = /^now(?:\(\))?(?:-(\d+)([smhd]))?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type TimeInput = {
  from?: string;
  to?: string;
  startDate?: string;
  endDate?: string;
  around?: string;
  window?: string;
  allowLongRange?: boolean;
  maxRangeMs?: number;
};

function unitMs(unit: string): number {
  switch (unit.toLowerCase()) {
    case "s":
      return 1000;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    case "d":
      return 86_400_000;
    default:
      throw new Error(`Unsupported time unit: ${unit}`);
  }
}

export function parseInstant(raw: string, nowMs = Date.now()): number {
  const s = raw.trim();
  const rel = s.match(RELATIVE_RE);
  if (rel) {
    if (!rel[1]) return nowMs;
    return nowMs - Number(rel[1]) * unitMs(rel[2]);
  }
  if (DATE_RE.test(s)) return Date.parse(`${s}T00:00:00.000Z`);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${raw}. Use now-30m, ISO-8601, or YYYY-MM-DD.`);
  }
  return ms;
}

export function parseWindow(raw: string | undefined, fallbackMs: number): number {
  if (!raw?.trim()) return fallbackMs;
  const s = raw.trim();
  const m = s.match(/^(\d+)([smhd])$/i);
  if (!m) throw new Error(`Invalid window: ${raw}. Use 30s, 2m, 1h, or 1d.`);
  return Number(m[1]) * unitMs(m[2]);
}

export function toDqlTime(raw: string): string {
  const s = raw.trim();
  const rel = s.match(RELATIVE_RE);
  if (rel) {
    if (!rel[1]) return "now()";
    return `now()-${rel[1]}${rel[2].toLowerCase()}`;
  }
  if (DATE_RE.test(s)) return `"${s}T00:00:00.000Z"`;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${raw}`);
  return `"${new Date(ms).toISOString()}"`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function resolveTime(input: TimeInput = {}, nowMs = Date.now()): TimeBounds {
  let fromMs: number | undefined;
  let toMs: number | undefined;

  if (input.startDate || input.endDate) {
    const start = (input.startDate ?? input.endDate)!.trim();
    const end = (input.endDate ?? input.startDate)!.trim();
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      throw new Error("startDate/endDate must be YYYY-MM-DD");
    }
    fromMs = Date.parse(`${start}T00:00:00.000Z`);
    toMs = Date.parse(`${end}T23:59:59.999Z`);
  }

  if (input.from) fromMs = parseInstant(input.from, nowMs);
  if (input.to) toMs = parseInstant(input.to, nowMs);

  if (input.around) {
    const pivot = parseInstant(input.around, nowMs);
    const half = parseWindow(input.window, 120_000);
    const aroundFrom = pivot - half;
    const aroundTo = pivot + half;
    fromMs = fromMs == null ? aroundFrom : Math.max(fromMs, aroundFrom);
    toMs = toMs == null ? aroundTo : Math.min(toMs, aroundTo);
  }

  if (fromMs == null && toMs == null) {
    fromMs = nowMs - 30 * 60_000;
    toMs = nowMs;
  } else if (fromMs == null) {
    fromMs = (toMs as number) - 30 * 60_000;
  } else if (toMs == null) {
    toMs = nowMs;
  }

  if (fromMs === undefined || toMs === undefined) {
    throw new Error("Could not resolve time bounds");
  }
  if (fromMs >= toMs) {
    throw new Error(`Invalid time range: from (${iso(fromMs)}) must be before to (${iso(toMs)})`);
  }

  const maxRange = input.maxRangeMs ?? 7 * 86_400_000;
  if (!input.allowLongRange && toMs - fromMs > maxRange) {
    throw new Error(
      `Time range exceeds ${Math.round(maxRange / 86_400_000)}d. Narrow from/to or set allowLongRange=true.`,
    );
  }

  return { from: iso(fromMs), to: iso(toMs), fromMs, toMs };
}

export function fetchTimeClause(bounds: TimeBounds): string {
  return `from:${toDqlTime(bounds.from)}, to:${toDqlTime(bounds.to)}`;
}
