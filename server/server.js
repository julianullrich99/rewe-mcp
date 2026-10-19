#!/usr/bin/env node
// Lokale Variante: Claude Desktop startet diesen Server per stdio auf demselben PC wie Chrome.
// Für den Betrieb auf einem Server im Netzwerk siehe http-server.js.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridge, registerTools, log } from "./lib.js";

const PORT = Number(process.env.REWE_MCP_PORT || 47823);

const httpServer = http.createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});
const { callExtension } = createBridge(httpServer, { password: process.env.REWE_MCP_PASSWORD });
httpServer.on("error", (e) => log("Port-Fehler:", e.message));
httpServer.listen(PORT, "127.0.0.1", () => log(`wartet auf Extension unter ws://127.0.0.1:${PORT}/ext`));

const server = new McpServer({ name: "rewe-shop", version: "1.1.0" });
registerTools(server, callExtension);
await server.connect(new StdioServerTransport());
log("MCP-Server bereit (stdio)");
