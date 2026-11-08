---
name: workflow-replay
description: Reuse or learn read-only HTTP workflows across local Codex projects. Use when a repeated task fits a configured workflow-replay profile, or when asked to inspect or demo the personal playbook.
---

# Workflow replay

Use the installed [runner](scripts/personal.mjs) from the current project. On Windows run `node --disable-warning=ExperimentalWarning "$env:USERPROFILE/.agents/skills/workflow-replay/scripts/personal.mjs"` followed by a subcommand.

- Run `profiles` to find the relevant configured service. `demo` tests the runner with synthetic data and an isolated temporary playbook.
- If the profile defines request contracts, try `PROFILE route "request"`. Use its result on a match. On a miss, `PROFILE lookup "task description"` returns up to three candidates. Use `PROFILE run ROUTE INPUTS.json` only when the route covers the complete request and its inputs are known. An unrelated or partial match falls back to normal tools.
- For a reusable task using registered read-only operations, see [recording and profile setup](references/profiles.md). Keep instance data and credentials outside the playbook. Replay uses the authorization for the current request.

Each service profile shares its playbook across local projects. The runner records calls it dispatches itself. Calls made through Codex's other tools continue through their own integrations.
