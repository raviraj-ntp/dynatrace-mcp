/**
 * @raviraj87/dynatrace-mcp · dql/escape.ts
 * DQL string escaping and filter fragments.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

export function dqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function asList(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function eqField(field: string, value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const v = value.trim();
  if (v.includes("*") && !v.startsWith("*")) {
    const prefix = v.replace(/\*+$/, "");
    return `startsWith(${field}, ${dqlString(prefix)})`;
  }
  if (v.startsWith("*") && v.endsWith("*") && v.length > 2) {
    return `contains(${field}, ${dqlString(v.slice(1, -1))})`;
  }
  if (v.endsWith("-") && v.length > 1) {
    return `startsWith(${field}, ${dqlString(v)})`;
  }
  return `${field} == ${dqlString(v)}`;
}

/** Pod filter: full replica name is exact; `my-app` / `my-app-` also matches `my-app-*`. */
export function k8sPodFilter(value: string | undefined, field = "k8s.pod.name"): string | undefined {
  if (!value?.trim()) return undefined;
  const v = value.trim();
  if (v.includes("*") || v.endsWith("-")) return eqField(field, v);
  const replicaName = /-[a-z0-9]{4,10}$/i.test(v) && v.split("-").length >= 3;
  if (replicaName) return `${field} == ${dqlString(v)}`;
  return `(${field} == ${dqlString(v)} or startsWith(${field}, ${dqlString(`${v}-`)}))`;
}

/** Workload: exact name or `name-*` replica, across workload/deployment fields. */
export function k8sWorkloadFilter(value: string | undefined, fields = ["k8s.workload.name"]): string | undefined {
  if (!value?.trim()) return undefined;
  const v = value.trim();
  const parts: string[] = [];
  for (const field of fields) {
    const exact = eqField(field, v);
    if (exact) parts.push(exact);
    if (!v.includes("*") && !v.endsWith("-")) {
      parts.push(`startsWith(${field}, ${dqlString(`${v}-`)})`);
    }
  }
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  return `(${[...new Set(parts)].join(" or ")})`;
}

export function orEq(field: string, values: string[]): string | undefined {
  if (!values.length) return undefined;
  if (values.length === 1) return eqField(field, values[0]);
  return `(${values.map((v) => `${field} == ${dqlString(v)}`).join(" or ")})`;
}

export function andFilters(parts: Array<string | undefined>): string {
  const ok = parts.filter((p): p is string => Boolean(p));
  if (!ok.length) return "";
  return ok.map((p) => `| filter ${p}`).join("\n");
}
