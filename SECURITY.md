# Security

Report vulnerabilities through a private repository security advisory when available. Share reproduction steps with synthetic data and redact credentials and private workflow inputs.

Workflow Replay runs user-owned JavaScript service profiles. Review profiles and keep them outside untrusted repositories. The supplied HTTPS dispatcher uses GET, pins the configured origin, refuses redirects, and resolves bearer credentials from the environment. Custom dispatchers should preserve the same read-only and authorization boundary. Workflow graphs use registered operations and typed references. Prompts cannot supply endpoint URLs or executable code.

Use a distinct profile and playbook for each credential scope. Enable local hooks only in intended project directories. Index generic examples without private values. The hook does not persist prompts. It returns projected data to the host on a supported match, and that data may appear in the host's context or logs.

The remote server is a single-profile, single-subject connector. Keep the listener on loopback and expose it through a trusted TLS proxy. Configure request limits and use short-lived OAuth access tokens. The demo is intended for local testing.

External actions are registered separately from automatic read workflows. Execute them through a trusted approval interface. Keep approval out of model-callable tools, partition the action ledger by deployment scope, and treat previews as sensitive if they contain recipient or message data. An uncertain action outcome requires checking the connected service before preparing a replacement. [Action setup and ledger behavior](docs/actions.md)
