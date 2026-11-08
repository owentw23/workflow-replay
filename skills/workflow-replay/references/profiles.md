# Profiles and recording

The Node 24 runner uses the current user's `~/.workflow-replay/profiles/` and `~/.workflow-replay/playbooks/`. A profile is a trusted, user-owned JavaScript module named `PROFILE.mjs`. Each profile has a separate SQLite playbook. Use a distinct profile for a different service, tenant, or credential scope. Keep project data out of route names, descriptions, and search examples.

Configure profiles only for services the user asks to connect. A profile declares a `registry` map of versioned operation IDs and exports its `dispatch` function. For flat JSON endpoints, import `httpsDispatcher` from the trusted runner's `src/workflow.mjs`. Use an absolute file URL (`file:///C:/...` on Windows), or a path relative to the profile file. Its origin must be a trusted HTTPS origin. It uses GET, rejects redirects, and reads an optional bearer token by environment variable name at runtime. The workflow cannot supply URLs, paths, or credentials.

```javascript
import { httpsDispatcher } from 'file:///absolute/path/to/workflow-replay/src/workflow.mjs';

export const registry = new Map([
  ['account_summary.v1', {
    path: '/api/account-summary',
    args: { account: 'string' },
    fields: { tier: 'string', open: 'integer' },
  }],
]);

export const dispatch = httpsDispatcher('https://service.example', registry, {
  tokenEnv: 'ACCOUNT_SERVICE_TOKEN',
});

export const contracts = new Map([['account-summary', request => {
  const match = /^Show the account summary for (acct-[0-9]{1,8})\.?$/i.exec(request);
  return match ? { account: match[1].toLowerCase() } : undefined;
}]]);
```

The registry uses `string`, `integer`, and `boolean` scalar types. The optional `contracts` export is a map keyed by published route ID. A contract receives the complete original request and returns typed inputs when the whole request fits. An optional `expand` function adds search synonyms. Expansion affects candidate search only. Contracts should reject extra filters, unknown input values, or additional actions.

From the repository, prefix the following commands with `node personal.mjs`. To learn a route, inspect `PROFILE tools` and use `examples/account-health.json` as a shape reference. A step argument references a named input or an earlier step's registered field. The output maps names to registered fields. Run `PROFILE learn ROUTE "description" WORKFLOW.json INPUTS.json` to execute the current request and save the verified plan on success. For the contract above, use the route ID `account-summary` and the input name `account`. Use `PROFILE index ROUTE EXAMPLES.json` to index a JSON array of generic, verified requests for it. `PROFILE playbook` displays the catalog. Set the service credential environment variable where the host launches the hook or MCP server.
