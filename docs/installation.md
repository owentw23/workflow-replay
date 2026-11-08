# Local installation

Install Node.js 24 or later and run `npm ci` from the repository. On PowerShell, use `npm.cmd` if the PowerShell npm shim is unavailable. Follow the [demo quick start](../README.md) to check the path before connecting a real service.

## Automatic hooks

Create a [trusted profile](../skills/workflow-replay/references/profiles.md), save a workflow, and define a complete-request contract. Test the profile with `node personal.mjs PROFILE route "request"`. A successful match returns `kind: "local"`.

Run `node install.mjs codex --project /absolute/project/path --profile NAME` or the same command with `claude` for Claude Code. The installer copies the local runner to a stable path under `~/.workflow-replay/runtime`, merges a `UserPromptSubmit` handler into the host's user hook configuration, and binds the project and its descendants to the profile. Existing hook files are backed up before replacement. Each run adds or replaces one workspace binding. More specific directories take precedence. Use the same profile in several project bindings to share its playbook.

- **Codex** requires one-time review and trust of the command in `/hooks`. The app can surface its own review flow. [Official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- **Claude Code** uses the command hook's executable-and-arguments form. Use a current Claude Code version supporting that form. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- Uninstall the handler with `node install.mjs codex --remove` or `node install.mjs claude --remove`. Bindings, profiles and playbooks are kept for reuse.

The hooks activate only for explicit workspace bindings and supported, complete prompts. They skip plan mode and add at most a 4 KB structured receipt. A miss, ambiguity, timeout, or unavailable profile leaves the host's ordinary tool loop in charge. The hooks do not read conversation transcripts. They run before the model so the result can reach the same turn. The host still controls its own inference and answer formatting.

## Local MCP

Configure a stdio MCP server with the absolute path to Node and to `mcp.mjs`. For Claude Desktop, use its local MCP configuration. For Codex or Claude Code, use the local MCP configuration if you prefer explicit host tool discovery over a prompt hook.

```json
{
  "mcpServers": {
    "workflow-replay": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/workflow-replay/mcp.mjs", "--profile", "replay-demo"]
    }
  }
}
```

The server exposes one read-only tool, `replay_workflow`. Its profile is fixed at startup. The tool accepts a complete request and returns either a bounded receipt or a no-match status. For real services, set `REPLAY_MCP_DESCRIPTION` to a short description of the tasks the deployed profile covers. Hosts use the description to decide when to call the tool.

For a profile with configured actions, add `--prepare-actions` to the local server's `args` to give the assistant access to typed inputs and previews. See the [approval workflow](actions.md).

## Custom chatbot

Use the pre-model route in a server you control. The adapter works independently of the model provider.

```js
import { replayConfigured } from './src/integration.mjs';
import { loadProfile } from './src/profiles.mjs';

const profile = await loadProfile('inventory');

export async function respond(text, ordinaryAgent) {
  let receipt;
  try {
    receipt = await replayConfigured(profile, text);
  } catch {
    // Continue through the normal agent when local replay is unavailable.
  }
  if (receipt) return receipt.result;
  return ordinaryAgent(text);
}
```

Bind profiles server-side to the authenticated principal and authorization scope. Request text contains only task input.
