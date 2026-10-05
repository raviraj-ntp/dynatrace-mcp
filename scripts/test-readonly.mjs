/**
 * @raviraj87/dynatrace-mcp · scripts/test-readonly.mjs
 * Read-only integration smoke test script.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import { ConnectionManager } from "../dist/client.js";
import { loadConfig } from "../dist/config.js";

const out = { ok: true, tests: [] };

async function run(name, fn) {
  try {
    const result = await fn();
    const s = JSON.stringify(result);
    out.tests.push({ name, status: "ok", preview: s.length > 800 ? `${s.slice(0, 800)}...` : s });
  } catch (err) {
    out.ok = false;
    out.tests.push({ name, status: "fail", error: err instanceof Error ? err.message : String(err) });
  }
}

let manager;
try {
  manager = new ConnectionManager(loadConfig());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const client = manager.get();

await run("list_connections", async () => manager.list());
await run("execute_dql_limit_1", () =>
  client.executeDql("fetch logs, from:now()-5m, to:now() | limit 1", { maxResultRecords: 1 }),
);
await run("query_problems", () =>
  client.executeDql(
    "fetch dt.davis.problems, from:now()-2h, to:now() | fields event.id, display_id, event.status, event.start, event.end, event.category, event.description, affected_entity_ids, related_entity_ids | sort event.start desc | limit 5",
    { maxResultRecords: 5 },
  ),
);

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
