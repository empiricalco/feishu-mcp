# feishu-mcp

Zero-dependency Cloudflare Worker exposing Feishu Base (bitable) as an MCP server usable across all Claude surfaces (claude.ai, mobile, Desktop, Cowork).

Six tools: `feishu_list_tables`, `feishu_list_fields`, `feishu_list_records`, `feishu_create_records`, `feishu_update_records`, `feishu_delete_records`.

No secrets live in this repo — credentials are injected as Worker secrets at runtime.

## Deploy — no terminal needed

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/empiricalco/feishu-mcp)

1. Tap the button (or paste `https://github.com/empiricalco/feishu-mcp` in the Cloudflare clone-repository flow) and deploy. Note the resulting URL `https://feishu-base-mcp.<account>.workers.dev`.
2. Cloudflare dashboard -> Workers & Pages -> the new Worker -> Settings -> **Variables and Secrets** -> Add (type: Secret) for each of:
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - `MCP_AUTH_TOKEN` (any long random string)
3. Redeploy from the dashboard if prompted.

## Feishu app setup

1. [open.feishu.cn](https://open.feishu.cn) -> your app -> Permissions -> add scope **`bitable:app`**. Publish a version if your tenant requires admin approval.
2. **Per Base:** open the Base -> `...` menu (top right) -> **Add document app** (添加文档应用) -> add the app with **edit** permission. Skipping this yields 91403 on every call.
3. App ID (`cli_...`) and App Secret are under Credentials & Basic Info.

## Add to Claude

claude.ai -> Settings -> Connectors -> **Add** -> **Custom**:

- **URL:** `https://feishu-base-mcp.<account>.workers.dev/mcp/<MCP_AUTH_TOKEN>`
- No OAuth fields — the path token authenticates.

Accounts with the request-headers beta can instead use the bare URL with header `Authorization: Bearer <MCP_AUTH_TOKEN>` (keeps the token out of URLs).

## Verify

```bash
curl -s https://feishu-base-mcp.<account>.workers.dev/mcp/<TOKEN> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expect six `feishu_*` tools.

## Notes

- Fails closed: no `MCP_AUTH_TOKEN` secret -> all requests 401.
- Tenant token cached in-isolate, refreshed 5 min before expiry.
- Batch tools cap at 500 records per call (Feishu limit).
- Field names must match Base column names exactly — call `feishu_list_fields` first.
- Rotate the token any time by updating the secret and the connector URL.

## Local test

```bash
node test.mjs   # mocks the Feishu API, exercises the full MCP surface
```
