# Hosted ChatGPT and Claude

The hosted clients connect to an MCP server you run. They decide whether to call its replay tool from the installed connector and its description. Availability and activation depend on the host and workspace. Some conversations require selecting or enabling the connector. The local prompt hook is available in Codex and Claude Code.

## Deploy a private connector

Use one dedicated service profile and OAuth subject per deployment. Seed and verify its workflows locally before starting the server. Put it behind an HTTPS reverse proxy that forwards `POST /mcp` and `GET /.well-known/oauth-protected-resource/mcp` and passes the `Authorization` header through. The server listens only on loopback and exposes no remote publishing or profile-selection tool.

Configure an OAuth provider that issues signed JWT access tokens using RS256 or ES256. It must advertise OAuth discovery and support the client registration or configured client credentials accepted by the host. Configure tokens with the exact public MCP URL as audience, the allowed subject, expiration, and scope `workflow:read`. Set these environment variables on the server.

| Variable | Example |
| --- | --- |
| `REPLAY_PUBLIC_MCP_URL` | `https://replay.example.com/mcp` |
| `REPLAY_OAUTH_ISSUER` | `https://identity.example.com` |
| `REPLAY_OAUTH_JWKS_URL` | `https://identity.example.com/.well-known/jwks.json` |
| `REPLAY_OAUTH_SUBJECT` | The single authorized identity's subject claim |
| `REPLAY_MCP_DESCRIPTION` | Brief description of the exact workflows offered |
| `REPLAY_MCP_AUTH_MODE` | `tool` for ChatGPT (default) or `resource` for HTTP-level OAuth discovery |

```sh
npm ci --omit=dev
node mcp.mjs --http --port 8788 --profile inventory
```

In `tool` mode, discovery exposes the public schema and protected calls can trigger ChatGPT's sign-in flow. In `resource` mode, unauthenticated MCP requests receive an HTTP 401 with the metadata URL. Both modes validate signature, issuer, audience, subject, expiration and scope before replay. TLS, proxy limits, identity-provider configuration and upstream credentials are the deployment operator's responsibility. [MCP authorization](https://apps.extensions.modelcontextprotocol.io/api/documents/authorization.html)

- **ChatGPT**. Add the HTTPS endpoint as a custom MCP plugin where workspace settings permit it, choose OAuth, and install the plugin. [Official ChatGPT custom MCP instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [ChatGPT OAuth requirements](https://developers.openai.com/plugins/build/auth)
- **Claude**. Start with `REPLAY_MCP_AUTH_MODE=resource`. Add the HTTPS endpoint as a custom connector and sign in. Enable the connector in the conversation where required. [Claude custom connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

Verify with a supported read and a similar request that should fall back. The repository tests the MCP protocol and authentication boundary locally. End-to-end hosted sign-in depends on the chosen identity provider and account settings.
