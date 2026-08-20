import worker from "./worker.js";
import assert from "node:assert";

const env = {
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "secret_test",
  MCP_AUTH_TOKEN: "tok123",
};

// Mock Feishu API
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/auth/v3/tenant_access_token/internal")) {
    return new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t-abc", expire: 7200 }));
  }
  if (u.includes("/bitable/v1/apps/appX/tables?")) {
    assert.equal(opts.headers.Authorization, "Bearer t-abc");
    return new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [{ table_id: "tbl1", name: "OKRs" }] } }));
  }
  if (u.includes("/records/search")) {
    return new Response(JSON.stringify({ code: 0, msg: "ok", data: { total: 1, has_more: false, items: [{ record_id: "rec1", fields: { Objective: "Grow WTF Partners" } }] } }));
  }
  if (u.includes("/bitable/v1/apps/appFORBIDDEN/")) {
    return new Response(JSON.stringify({ code: 91403, msg: "Forbidden" }));
  }
  throw new Error("Unexpected fetch: " + u);
};

async function post(path, body, headers = {}) {
  return worker.fetch(
    new Request("https://x.workers.dev" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env
  );
}

// 1. Unauthorized
let r = await post("/mcp/wrong", { jsonrpc: "2.0", id: 1, method: "ping" });
assert.equal(r.status, 401, "wrong path token rejected");
r = await post("/", { jsonrpc: "2.0", id: 1, method: "ping" });
assert.equal(r.status, 401, "no auth rejected");

// 2. Bearer auth works
r = await post("/", { jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer tok123" });
assert.equal(r.status, 200, "bearer accepted");

// 3. initialize via path token
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
let j = await r.json();
assert.equal(j.result.protocolVersion, "2025-03-26", "echoes supported version");
assert.equal(j.result.serverInfo.name, "feishu-base-mcp");

// 4. notifications/initialized -> 202, no body
r = await post("/mcp/tok123", { jsonrpc: "2.0", method: "notifications/initialized" });
assert.equal(r.status, 202, "notification gets 202");

// 5. tools/list
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 3, method: "tools/list" });
j = await r.json();
assert.equal(j.result.tools.length, 6, "six tools");
assert.ok(j.result.tools.every((t) => t.name.startsWith("feishu_") && t.inputSchema.type === "object"));

// 6. tools/call -> list_tables
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "feishu_list_tables", arguments: { app_token: "appX" } } });
j = await r.json();
assert.equal(j.result.structuredContent.tables[0].table_id, "tbl1");
assert.ok(!j.result.isError);

// 7. tools/call -> list_records
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "feishu_list_records", arguments: { app_token: "appX", table_id: "tbl1" } } });
j = await r.json();
assert.equal(j.result.structuredContent.records[0].fields.Objective, "Grow WTF Partners");

// 8. Feishu 91403 -> tool error with hint, not protocol error
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "feishu_list_tables", arguments: { app_token: "appFORBIDDEN" } } });
j = await r.json();
assert.equal(j.result.isError, true);
assert.ok(j.result.content[0].text.includes("Add document app"), "actionable hint present");

// 9. Unknown tool
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } });
j = await r.json();
assert.equal(j.error.code, -32602);

// 10. Unknown method
r = await post("/mcp/tok123", { jsonrpc: "2.0", id: 8, method: "bogus/method" });
j = await r.json();
assert.equal(j.error.code, -32601);

globalThis.fetch = realFetch;
console.log("ALL TESTS PASSED");
