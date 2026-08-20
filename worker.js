/**
 * Feishu Base (bitable) MCP server — Cloudflare Worker, zero dependencies.
 *
 * Transport: MCP streamable HTTP, stateless JSON responses.
 * Auth (client -> worker): Bearer token, or token embedded in path /mcp/<token>.
 * Auth (worker -> Feishu): tenant_access_token from app credentials, cached in-isolate.
 *
 * Secrets:
 *   FEISHU_APP_ID      - Feishu app ID (cli_xxx)
 *   FEISHU_APP_SECRET  - Feishu app secret
 *   MCP_AUTH_TOKEN     - long random string; shared secret for Claude -> worker
 * Optional vars:
 *   FEISHU_BASE_URL    - default https://open.feishu.cn (use https://open.larksuite.com for Lark intl)
 */

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "feishu-base-mcp", version: "1.0.0" };

// ---------------------------------------------------------------------------
// Feishu API client
// ---------------------------------------------------------------------------

let tokenCache = { token: null, expiresAt: 0 };

async function getTenantToken(env) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const base = env.FEISHU_BASE_URL || "https://open.feishu.cn";
  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Feishu auth failed (code ${data.code}): ${data.msg}. Check FEISHU_APP_ID / FEISHU_APP_SECRET secrets.`);
  }
  tokenCache = { token: data.tenant_access_token, expiresAt: now + data.expire * 1000 };
  return tokenCache.token;
}

async function feishuRequest(env, method, path, body) {
  const base = env.FEISHU_BASE_URL || "https://open.feishu.cn";
  const token = await getTenantToken(env);
  const res = await fetch(`${base}/open-apis${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(feishuErrorHint(data));
  }
  return data.data;
}

function feishuErrorHint(data) {
  const hints = {
    91402: "NOTEXIST: app_token or table_id not found — check the Base URL segment after /base/ for app_token.",
    91403: "FORBIDDEN: the Feishu app has no access to this Base. Open the Base -> ... menu -> Add document app, and add this app as editor.",
    1254045: "Field name mismatch — field names in `fields` must exactly match Base column names (case- and space-sensitive). Use feishu_list_fields first.",
    99991663: "Tenant token invalid/expired — retried tokens are cached; if persistent, verify app credentials.",
  };
  const hint = hints[data.code] ? ` Hint: ${hints[data.code]}` : "";
  return `Feishu API error ${data.code}: ${data.msg}.${hint}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "feishu_list_tables",
    description:
      "List all tables in a Feishu Base. Returns table_id and name for each. The app_token is the segment after /base/ in the Base URL (e.g. https://xxx.feishu.cn/base/APP_TOKEN).",
    inputSchema: {
      type: "object",
      properties: {
        app_token: { type: "string", description: "Base app token from the Base URL" },
      },
      required: ["app_token"],
    },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const d = await feishuRequest(env, "GET", `/bitable/v1/apps/${a.app_token}/tables?page_size=100`);
      return { tables: (d.items || []).map((t) => ({ table_id: t.table_id, name: t.name })) };
    },
  },
  {
    name: "feishu_list_fields",
    description:
      "List fields (columns) of a table in a Feishu Base: field name, type, and options. Call this before creating/updating records so field names match exactly.",
    inputSchema: {
      type: "object",
      properties: {
        app_token: { type: "string" },
        table_id: { type: "string", description: "From feishu_list_tables (tbl...)" },
      },
      required: ["app_token", "table_id"],
    },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const d = await feishuRequest(env, "GET", `/bitable/v1/apps/${a.app_token}/tables/${a.table_id}/fields?page_size=100`);
      return {
        fields: (d.items || []).map((f) => ({
          field_name: f.field_name,
          type: f.type,
          ui_type: f.ui_type,
          options: f.property?.options?.map((o) => o.name),
        })),
      };
    },
  },
  {
    name: "feishu_list_records",
    description:
      "List records of a table (paginated). Returns record_id + fields per record, and page_token if more pages exist. Optional view_id restricts to a view's rows/filter.",
    inputSchema: {
      type: "object",
      properties: {
        app_token: { type: "string" },
        table_id: { type: "string" },
        page_size: { type: "integer", description: "1-500, default 100" },
        page_token: { type: "string", description: "From previous page's page_token" },
        view_id: { type: "string", description: "Optional view (vew...)" },
        field_names: { type: "array", items: { type: "string" }, description: "Optional: only return these fields" },
      },
      required: ["app_token", "table_id"],
    },
    annotations: { readOnlyHint: true },
    handler: async (env, a) => {
      const qs = new URLSearchParams();
      qs.set("page_size", String(a.page_size || 100));
      if (a.page_token) qs.set("page_token", a.page_token);
      const body = {};
      if (a.view_id) body.view_id = a.view_id;
      if (a.field_names) body.field_names = a.field_names;
      const d = await feishuRequest(
        env,
        "POST",
        `/bitable/v1/apps/${a.app_token}/tables/${a.table_id}/records/search?${qs}`,
        body
      );
      return {
        total: d.total,
        has_more: d.has_more,
        page_token: d.has_more ? d.page_token : undefined,
        records: (d.items || []).map((r) => ({ record_id: r.record_id, fields: r.fields })),
      };
    },
  },
  {
    name: "feishu_create_records",
    description:
      "Batch-create records in a table (max 500 per call). Each record is a `fields` object keyed by exact field names. Text fields take strings; single-select takes the option name; number fields take numbers.",
    inputSchema: {
      type: "object",
      properties: {
        app_token: { type: "string" },
        table_id: { type: "string" },
        records: {
          type: "array",
          description: 'e.g. [{"fields": {"Objective": "Grow WTF Partners", "Weight": 0.05}}]',
          items: {
            type: "object",
            properties: { fields: { type: "object" } },
            required: ["fields"],
          },
        },
      },
      required: ["app_token", "table_id", "records"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (env, a) => {
      const d = await feishuRequest(
        env,
        "POST",
        `/bitable/v1/apps/${a.app_token}/tables/${a.table_id}/records/batch_create`,
        { records: a.records }
      );
      return { created: (d.records || []).map((r) => r.record_id) };
    },
  },
  {
    name: "feishu_update_records",
    description:
      "Batch-update records (max 500 per call). Each item needs record_id and a partial `fields` object — only the fields provided are changed.",
    inputSchema: {
      type: "object",
      properties: {
        app_token: { type: "string" },
        table_id: { type: "string" },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: { record_id: { type: "string" }, fields: { type: "object" } },
            required: ["record_id", "fields"],
          },
        },
      },
      required: ["app_token", "table_id", "records"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (env, a) => {
      const d = await feishuRequest(
        env,
        "POST",
        `/bitable/v1/apps/${a.app_token}/tables/${a.table_id}/records/batch_update`,
        { records: a.records }
      );
      return { updated: (d.records || []).map((r) => r.record_id) };
    },
  },
  {
    name: "feishu_delete_records",
    description: "Batch-delete records by record_id (max 500 per call). Irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        app_token: { type: "string" },
        table_id: { type: "string" },
        record_ids: { type: "array", items: { type: "string" } },
      },
      required: ["app_token", "table_id", "record_ids"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (env, a) => {
      await feishuRequest(
        env,
        "POST",
        `/bitable/v1/apps/${a.app_token}/tables/${a.table_id}/records/batch_delete`,
        { records: a.record_ids }
      );
      return { deleted: a.record_ids };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP JSON-RPC handling (streamable HTTP, stateless)
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(env, msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.handler(env, params.arguments || {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: String(e.message || e) }],
          isError: true,
        });
      }
    }
    default:
      // Notifications (no id) get no response body per JSON-RPC.
      if (id === undefined || id === null) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function authorized(request, url, env) {
  if (!env.MCP_AUTH_TOKEN) return false; // fail closed if secret unset
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer && bearer === env.MCP_AUTH_TOKEN) return true;
  // Path form: /mcp/<token>
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[0] === "mcp" && parts[1] === env.MCP_AUTH_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("feishu-base-mcp: POST MCP requests to /mcp/<token> or / with Bearer auth.", { status: 200 });
    }

    if (!authorized(request, url, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      // No server-initiated stream in stateless mode.
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const msg of messages) {
      const res = await handleRpc(env, msg);
      if (res) responses.push(res);
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
