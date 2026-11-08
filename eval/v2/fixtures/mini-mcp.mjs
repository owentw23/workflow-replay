// Tiny stdio MCP server for wrap tests: one annotated read tool, one unannotated read tool, one destructive tool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const items = { a1: { id: 'a1', name: 'Widget', stock: 4 }, b2: { id: 'b2', name: 'Gadget', stock: 0 } };
const server = new McpServer({ name: 'mini', version: '1.0.0' });
const text = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
server.registerTool('item_details', { description: 'Details of one item', inputSchema: { id: z.string() },
  annotations: { readOnlyHint: true } }, async ({ id }) => text(items[id] ?? { error: 'none' }));
server.registerTool('list_items', { description: 'List items, optionally only in stock', inputSchema: { in_stock: z.boolean().optional() } },
  async ({ in_stock: inStock }) => text(Object.values(items).filter(item => !inStock || item.stock > 0)));
server.registerTool('delete_item', { description: 'Delete an item', inputSchema: { id: z.string() },
  annotations: { destructiveHint: true } }, async ({ id }) => text({ deleted: id }));
await server.connect(new StdioServerTransport());
