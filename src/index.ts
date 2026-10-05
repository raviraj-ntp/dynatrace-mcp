#!/usr/bin/env node

/**
 * ------------------------------------------------------------------------------
 * Package : @raviraj87/dynatrace-mcp
 * File    : index.ts
 * Purpose : MCP server bootstrap — Dynatrace Grail tools and stdio transport.
 *
 * Copyright (c) 2026 Ravi Raj
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * SPDX-License-Identifier: MIT
 * ------------------------------------------------------------------------------
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConnectionManager } from "./client.js";
import { loadConfig } from "./config.js";
import { registerDynatraceTools } from "./tools/registerTools.js";

const config = loadConfig();
const manager = new ConnectionManager(config);

const server = new McpServer(
  {
    name: "dynatrace-mcp",
    version: "1.0.0",
  },
  {
    instructions:
      "Generic Dynatrace Grail MCP for any tenant. Never assume cluster/namespace/workload/pod names — discover with list_clusters / list_namespaces / list_pods. Incident flow: P-id → dynatrace_triage_problem; otherwise dynatrace_triage_scope after discovering scope. Then logs (summary → search → surrounding), kube issue events + pod quota + workload replicas, service_health / failed_spans / slow_spans / get_trace. Pod Running status is kube metrics, not logs. Quiet pods can have quota and no log lines.",
  },
);

registerDynatraceTools(server, manager);

const transport = new StdioServerTransport();
await server.connect(transport);
