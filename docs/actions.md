# Approval-gated workflows

A saved action workflow is a trusted profile definition. It declares typed placeholders, an optional read-only preparation plan, and one versioned operation to execute after approval. The optional `match` contract handles a complete request and can bind inputs directly. `source` and `description` fields tell the assistant whether to ask the user or draft a value itself. The runner validates the result in either case.

## Connect a tool

In a [profile](../skills/workflow-replay/references/profiles.md), export `actions` and `actionTools` alongside the existing `registry` and `dispatch`. The two registries use separate operation IDs. This example assumes you have an MCP server with a `send_email` tool that accepts `to`, `body` and `idempotency_key` and returns `structuredContent` with `messageId`. Replace the file URL and executable with your own trusted paths.

```js
import { mcpAction } from 'file:///absolute/path/to/workflow-replay/src/mcp-action.mjs';

export const registry = new Map();
export async function dispatch() { throw new Error('No read operations configured'); }

export const actionTools = new Map([['send-email.v1', {
  args: { to: 'string', body: 'string' },
  fields: { messageId: 'string' },
  call: mcpAction({
    command: '/absolute/path/to/node',
    args: ['/absolute/path/to/trusted/mail-server.mjs'],
    tool: 'send_email',
    idempotencyArgument: 'idempotency_key',
  }),
}]]);

export const actions = new Map([['send-update', {
  match: request => /^send a project update email\.?$/i.test(request) ? {} : undefined,
  inputs: {
    recipient: { type: 'string', source: 'user', description: 'Recipient email address' },
    message: { type: 'string', source: 'model', description: 'Draft from facts supplied by the user' },
  },
  operation: 'send-email.v1',
  args: { to: { input: 'recipient' }, body: { input: 'message' } },
}]]);
```

An action can also use a `prepare` [read workflow](../examples/account-health.json) with inputs drawn from the action placeholders. Reference a projected read field with `{ prepared: 'field-name' }`. If the model needs facts to draft a missing value, specify `draftContext` with the names of the projected fields it should see. Once the placeholders are filled, preparation fetches fresh values and freezes the exact final arguments for approval.

For an API, CLI, browser automation, or host-native tool you control, implement `call(args, { idempotencyKey, signal })` in trusted code. Honor cancellation, validate service-specific arguments and current authorization, and return structured fields. Forward the key if the upstream supports deduplication. The built-in MCP bridge uses stdio and a fixed executable and tool name. For a tool available only within a host's interface, that host must expose a callable boundary or accept a handoff in your application. Version the operation ID if its target or meaning changes.

## Local assistant and terminal

Start the local MCP server with `node mcp.mjs --profile NAME --prepare-actions` using the host's [stdio setup](installation.md#local-mcp). On a match, `prepare_workflow_action` returns missing inputs or a proposal. The assistant can fill the draft placeholders and save the returned JSON to a review file. A user can also run the preparation from a terminal with a JSON object containing the known inputs.

```sh
node personal.mjs NAME action-prepare send-update inputs.json > preview.json
node personal.mjs NAME action-approve preview.json
```

Use UTF-8 for the preview file. Review the exact operation and arguments in the interactive terminal, then type `approve` if they are correct. Treat the preview like the data it contains. Local MCP exposes preparation only, and the hosted MCP endpoint and background prompt hooks keep their read-only behavior.

## Application integration

In an application you control, use `matchAction(profile, request)` before the ordinary agent. Use `prepareAction(profile, route, inputs, principal)` to obtain placeholders or a proposal. Resolve missing inputs with your model or user interface. Then call `commitAction(profile, proposal, { principal, approve })`. Supply the principal from authenticated application state and implement `approve` in trusted application code to return true only after the user approves the exact proposal. Keep this function outside the model's callable tools.

Proposals expire after ten minutes. The per-profile SQLite ledger stores only a proposal hash, ID, expiry, and state. Each proposal can be dispatched at most once, including concurrent approvals. A repeat returns the recorded status. `unknown` indicates the tool may have acted before reporting an error. A persisted `running` after a crash requires the same upstream check. Verify the outcome before preparing a replacement. This guarantee is per proposal. Upstream idempotency depends on the configured service.
