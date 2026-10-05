/**
 * @raviraj87/dynatrace-mcp · redact.ts
 * Truncate log lines and redact likely secrets.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

const SECRET_RES: RegExp[] = [
  /\b(authorization\s*[:=]\s*)([^\s,;"']+)/gi,
  /\b(bearer\s+)([a-z0-9._\-+=/]{8,})/gi,
  /\bdt0[a-z0-9]{2}\.[A-Za-z0-9._-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b((?:password|passwd|secret|api[_-]?key|access[_-]?token|token)\s*[:=]\s*)([^\s,;"']+)/gi,
  /\b((?:mongodb|mysql|postgres(?:ql)?|redis):\/\/)([^/\s]+)@/gi,
];

export function redactText(value: string): string {
  let out = value;
  for (const re of SECRET_RES) {
    out = out.replace(re, (match, g1?: string, g2?: string) => {
      if (g1 && g2) return `${g1}***`;
      return "***";
    });
  }
  return out;
}

export function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

export function sanitizeLogContent(value: unknown, maxChars = 2000): unknown {
  if (typeof value !== "string") return value;
  return truncateText(redactText(value), maxChars);
}

export function sanitizeRecords(records: Record<string, unknown>[], maxChars = 2000): Record<string, unknown>[] {
  return records.map((row) => {
    const next: Record<string, unknown> = { ...row };
    for (const key of ["content", "event.description", "message", "log.content"]) {
      if (key in next) next[key] = sanitizeLogContent(next[key], maxChars);
    }
    return next;
  });
}
