/**
 * @raviraj87/dynatrace-mcp · tools/registerTools.ts
 * MCP tool registry for Dynatrace workflows.
 *
 * Copyright (c) 2026 Ravi Raj · MIT License · see LICENSE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../client.js";
import { registerCoreTools } from "./coreTools.js";
import { registerK8sTools } from "./k8sTools.js";
import { registerLogTools } from "./logTools.js";
import { registerSecurityTools } from "./securityTools.js";
import { registerTriageTools } from "./triageTools.js";

export function registerDynatraceTools(server: McpServer, manager: ConnectionManager): void {
  registerCoreTools(server, manager);
  registerK8sTools(server, manager);
  registerLogTools(server, manager);
  registerTriageTools(server, manager);
  registerSecurityTools(server, manager);
}
