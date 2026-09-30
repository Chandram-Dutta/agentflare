import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { retainContent, appendContent, boundContent, promptContent } from "./content.mjs";
import { createAuthCheckpoint } from "./auth-checkpoint.mjs";
import { createCheckpointLoop } from "./checkpoint-loop.mjs";

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function stopChildTree(child) {
  if (!child.pid) return;
  const exited = childExit(child);
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  // Waiting for just the adapter is insufficient: its app-server may still be
  // flushing SQLite/rollouts. Do not start an archive while any group writer lives.
  for (let attempt = 0; attempt < 200; attempt++) {
    const entries = await readdir("/proc");
    const states = await Promise.all(entries.filter((id) => /^\d+$/.test(id)).map(async (id) => {
      try {
        const stat = await readFile(`/proc/${id}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return Number(fields[2]) === child.pid && !["Z", "X"].includes(fields[0]);
      } catch { return false; }
    }));
    if (!states.some(Boolean)) { await exited; return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Fail the checkpoint rather than force-killing a writer and claiming a clean save.
  throw new Error("Agent processes did not stop cleanly");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One ACP transport is shared by all conversations belonging to a user.  The
// ACP session id (rather than the HTTP connection) is the routing boundary.
export function createUserBridge({
  command = ["/opt/agentflare/acp/node_modules/.bin/codex-acp"],
  root = "/workspace/threads",
  authCheckpoint,
  onSettled = () => {},
} = {}) {
  const contexts = new Map();
  const routes = new Map();
  const deleted = new Set();
  let initialized;
  let dead = false;
  let authentication;
  let login;
  let loginResolve;
  let loggingOut = false;
  let quiescing = false;
  let quiesced = false;
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...Object.fromEntries(["PATH", "HOME", "LANG", "TERM", "CODEX_HOME"].flatMap(
        (key) => process.env[key] === undefined ? [] : [[key, process.env[key]]],
      )),
      NO_BROWSER: "1",
    },
  });
  child.stderr.resume();

  const normalize = (options = [], modes) => {
    const result = (Array.isArray(options) ? options : []).flatMap((o) => {
      if (o?.type !== "select" || typeof o.id !== "string" || typeof o.name !== "string" ||
          typeof o.currentValue !== "string" || !Array.isArray(o.options)) return [];
      const choices = o.options.flatMap((x) => Array.isArray(x?.options) ? x.options : [x])
        .flatMap((x) => typeof x?.value === "string" && typeof x.name === "string"
          ? [{ value: x.value, name: x.name, ...(typeof x.description === "string" ? { description: x.description } : {}) }]
          : []);
      if (!choices.some((x) => x.value === o.currentValue)) return [];
      return [{ id: o.id, name: o.name, currentValue: o.currentValue, options: choices,
        ...(typeof o.category === "string" ? { category: o.category } : {}),
        ...(typeof o.description === "string" ? { description: o.description } : {}) }];
    });
    if (!result.some((o) => o.id === "mode") && modes?.availableModes) {
      const choices = modes.availableModes.flatMap((x) => typeof x?.id === "string" && typeof x.name === "string"
        ? [{ value: x.id, name: x.name }] : []);
      if (choices.some((x) => x.value === modes.currentModeId))
        result.unshift({ id: "mode", name: "Mode", category: "mode", currentValue: modes.currentModeId, options: choices });
    }
    return result;
  };
  const bound = (s) => {
    let size = s.messages.reduce((n, m) => n + m.text.length, 0);
    while (s.messages.length > 1 && (size > 128000 || s.messages.length > 300)) {
      size -= s.messages.shift().text.length;
      s.truncated = true;
    }
  };
  const append = (c, role, text, id = crypto.randomUUID(), status) => {
    if (text.length > 64000) c.snapshot.truncated = true;
    c.snapshot.messages.push({ id, role, text: text.slice(0, 64000), ...(status ? { status } : {}) });
    bound(c.snapshot);
  };
  const settle = (c) => {
    for (const p of c.permissions.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    c.permissions.clear();
    c.snapshot.permissions = [];
  };
  const fail = (c, error, operation = "session") => {
    settle(c);
    c.snapshot.status = !dead && error?.code === -32000 ? "auth-required" : "error";
    const missing = typeof error?.data?.details === "string" && /no rollout found for thread id|thread not found:|thread not loaded:/.test(error.data.details);
    const limited = error?.data?.codexErrorInfo === "usageLimitExceeded";
    const reason = dead ? "connection-closed" : missing ? "session-missing" : limited ? "usage-limit" : c.snapshot.status === "auth-required" ? "auth-required" : "request-failed";
    // Never log raw provider errors: their details can contain prompts or secrets.
    console.error({ event: "codex_session_failed", operation, reason, code: Number.isFinite(error?.code) ? error.code : undefined });
    if (c.snapshot.status === "error") c.snapshot.error = dead
      ? "The Codex connection closed. Reconnect to reload this session."
      : missing
        ? "Codex could not find the saved session. Reconnect will retry loading it; your workspace files have not been deleted."
        : limited
          ? "Codex usage limit reached. Check your OpenAI account limits before reconnecting."
          : operation === "load"
            ? "Codex could not load this conversation. Reconnect to retry."
            : operation === "prompt"
              ? "Codex could not complete this turn. Reconnect to reload the conversation; the prompt will not be sent again automatically."
              : "Codex could not open this session. Reconnect to retry.";
    else delete c.snapshot.error;
  };
  const failAll = () => {
    if (dead) return;
    dead = true;
    if (loginResolve) loginResolve({ action: "cancel" });
    for (const c of contexts.values()) fail(c);
  };
  const update = (c, u) => {
    const s = c.snapshot;
    if (["agent_message_chunk", "user_message_chunk", "agent_thought_chunk"].includes(u.sessionUpdate)) {
      const role = u.sessionUpdate === "agent_message_chunk" ? "assistant" : u.sessionUpdate === "agent_thought_chunk" ? "thought" : "user";
      const last = s.messages.at(-1);
      const explicitId = typeof u.messageId === "string" && u.messageId ? u.messageId : undefined;
      const id = explicitId ?? (last && last.id === c.currentMessage && last.role === role ? c.currentMessage : crypto.randomUUID());
      if (last && last.id === id && last.role === role) {
        last.content ??= last.text ? [{ type: "text", text: last.text }] : [];
        if (appendContent(last, u.content)) s.truncated = true;
        if (u.content?.type === "text") {
          if (last.text.length + u.content.text.length > 64000) s.truncated = true;
          last.text = (last.text + u.content.text).slice(0, 64000);
        }
      }
      else {
        append(c, role, u.content?.type === "text" ? u.content.text : "", id);
        s.messages.at(-1).content = [retainContent(u.content)];
      }
      c.currentMessage = id;
    } else if (u.sessionUpdate === "config_option_update") {
      const before = s.configOptions.find(o => o.id === "model" || o.category === "model")?.currentValue;
      s.configOptions = normalize(u.configOptions);
      if (before !== s.configOptions.find(o => o.id === "model" || o.category === "model")?.currentValue) delete s.contextUsage;
    } else if (u.sessionUpdate === "current_mode_update") {
      const mode = s.configOptions.find(o => o.id === "mode");
      if (mode?.options.some(o => o.value === u.currentModeId)) mode.currentValue = u.currentModeId;
    }
    else if (u.sessionUpdate === "usage_update" && Number.isFinite(u.used) && u.used >= 0 && Number.isFinite(u.size) && u.size > 0)
      s.contextUsage = { used: u.used, size: u.size };
    else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      c.currentMessage = undefined;
      let item = s.messages.find((m) => m.role === "tool" && m.id === u.toolCallId);
      if (!item) { append(c, "tool", u.title ?? "Tool call", u.toolCallId, u.status ?? "pending"); item = s.messages.at(-1); }
      if (u.title) item.text = u.title.slice(0, 64000);
      if (u.status) item.status = u.status;
      const text = u.content?.filter(x => x.type === "content" && x.content?.type === "text").map(x => x.content.text).join("\n");
      if (u.content) item.content = u.content.filter(x => x.type === "content").map(x => retainContent(x.content));
      if (text) item.text = `${u.title ?? item.text.split("\n")[0]}\n${text}`.slice(0, 64000);
    }
    boundContent(s);
    bound(s);
  };

  const connection = client({ name: "agentflare" })
    .onNotification(methods.client.session.update, (ctx) => {
      const c = routes.get(ctx.params.sessionId);
      if (c) update(c, ctx.params.update);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => new Promise((resolve) => {
      const c = routes.get(ctx.params.sessionId);
      const p = ctx.params;
      if (!c || c.snapshot.status !== "running" || c.permissions.size >= 32 || !p.options?.length)
        return resolve({ outcome: { outcome: "cancelled" } });
      const id = crypto.randomUUID();
      const options = p.options.map(({ optionId, name, kind }) => ({ optionId, name, kind }));
      c.permissions.set(id, { resolve, options });
      c.snapshot.permissions.push({ id, title: p.toolCall.title, options });
    }))
    .onRequest(methods.client.elicitation.create, (ctx) => new Promise((resolve) => {
      let url;
      try { url = new URL(ctx.params.url); } catch { /* invalid */ }
      if (!authentication || loginResolve || ctx.params.mode !== "url" || url?.protocol !== "https:" ||
          url.username || url.password || !["auth.openai.com", "chatgpt.com"].includes(url.hostname))
        return resolve({ action: "cancel" });
      loginResolve = resolve;
      login = { id: ctx.params.elicitationId, url: url.href, message: ctx.params.message.slice(0, 2000) };
      for (const c of contexts.values()) if (c.snapshot.status === "authenticating") c.snapshot.login = login;
    }))
    .onNotification(methods.client.elicitation.complete, (ctx) => {
      if (login?.id === ctx.params.elicitationId) {
        login = undefined;
        for (const c of contexts.values()) delete c.snapshot.login;
      }
    })
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const agent = connection.agent;
  connection.signal.addEventListener("abort", failAll, { once: true });
  child.on("error", failAll);
  child.on("exit", failAll);
  const init = agent.request(methods.agent.initialize, {
    protocolVersion: 1, clientCapabilities: { elicitation: { url: {} } },
    clientInfo: { name: "agentflare", version: "1" },
  }).then((x) => {
    if (x.protocolVersion !== 1) throw new Error("Unsupported ACP version");
    initialized = x;
  }).catch((e) => { failAll(); throw e; });
  void init.catch(() => {});

  async function open(c) {
    let saved;
    try { saved = (await readFile(c.sessionFile, "utf8")).trim(); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    c.currentMessage = undefined;
    let result;
    c.openOperation = saved ? "load" : "new";
    if (saved) {
      c.sessionId = saved;
      routes.set(saved, c); // load may replay notifications before its response
      const previousMessages = c.snapshot.messages;
      c.snapshot.messages = [];
      try { result = await agent.request(methods.agent.session.load, { sessionId: saved, cwd: c.cwd, mcpServers: [] }); }
      catch (e) { c.snapshot.messages = previousMessages; routes.delete(saved); throw e; }
    } else {
      result = await agent.request(methods.agent.session.new, { cwd: c.cwd, mcpServers: [] });
      c.freshSession = true;
      c.sessionId = result.sessionId;
      routes.set(c.sessionId, c);
      await mkdir(dirname(c.sessionFile), { recursive: true, mode: 0o700 });
      await writeFile(`${c.sessionFile}.tmp`, c.sessionId, { mode: 0o600 });
      await rename(`${c.sessionFile}.tmp`, c.sessionFile);
    }
    c.snapshot.configOptions = normalize(result.configOptions, result.modes);
    c.snapshot.promptCapabilities = initialized.agentCapabilities?.promptCapabilities ?? {};
    if (dead || c.deleted) throw Error("Disconnected");
    c.snapshot.status = "ready";
    delete c.snapshot.error;
  }
  async function authenticate() {
    if (authentication) return authentication;
    if (!initialized?.authMethods?.some(m => m.id === "chat-gpt-device-code")) throw Error("Device login unavailable");
    for (const c of contexts.values()) if (c.snapshot.status === "auth-required") c.snapshot.status = "authenticating";
    authentication = agent.request(methods.agent.authenticate, { methodId: "chat-gpt-device-code" })
      .then(async () => {
        const retry = [...contexts.values()].filter((c) => ["auth-required", "authenticating"].includes(c.snapshot.status));
        await Promise.all(retry.map((c) => open(c).catch((e) => fail(c, e))));
      }).catch((e) => { for (const c of contexts.values()) if (c.snapshot.status === "authenticating") fail(c, e); })
      .finally(() => { authentication = undefined; login = undefined; loginResolve = undefined; for (const c of contexts.values()) delete c.snapshot.login; });
    return authentication;
  }
  async function act(c, action) {
    if (dead || c.deleted || loggingOut || quiescing) throw new Error("Disconnected");
    if (action.type === "connect") {
      // A live transport can contain an errored session. Retry only that session,
      // never restart siblings, create a replacement history, or resubmit a turn.
      if (c.snapshot.status !== "error") return;
      c.snapshot.status = "connecting";
      delete c.snapshot.error;
      c.public.ready = init.then(() => open(c)).catch(e => fail(c, e, c.openOperation));
    } else if (action.type === "authenticate") {
      if (c.snapshot.status !== "auth-required" && c.snapshot.status !== "authenticating") throw new Error("Not ready for login");
      void authenticate().catch(e => fail(c, e));
    } else if (action.type === "login-response") {
      if (!login || login.id !== action.id || !loginResolve) throw new Error("Login request expired");
      const resolve = loginResolve; loginResolve = undefined; resolve({ action: action.action });
      if (action.action === "cancel") { login = undefined; for (const x of contexts.values()) delete x.snapshot.login; }
    } else if (action.type === "prompt") {
      if (c.promptIds.has(action.requestId)) return;
      if (c.snapshot.status !== "ready" || typeof action.text !== "string" || (!action.text.trim() && !action.attachments?.length) || action.text.length > 16000 || typeof action.requestId !== "string") throw new Error("Cannot send prompt");
      const content = promptContent(action, c.snapshot.promptCapabilities);
      c.promptIds.add(action.requestId); if (c.promptIds.size > 1000) c.promptIds.delete(c.promptIds.values().next().value);
      c.turn = action.requestId;
      append(c, "user", action.text, action.requestId);
      if (action.attachments?.length) c.snapshot.messages.at(-1).content = content;
      boundContent(c.snapshot);
      c.currentMessage = undefined; c.snapshot.status = "running";
      c.prompt = agent.request(methods.agent.session.prompt, { sessionId: c.sessionId, prompt: content })
        .then(() => { settle(c); if (!dead && !c.deleted) c.snapshot.status = "ready"; onSettled(); }).catch((e) => fail(c, e, "prompt"));
    } else if (action.type === "permission") {
      const p = c.permissions.get(action.id);
      if (!p || !p.options.some((x) => x.optionId === action.optionId)) throw new Error("Permission request expired or invalid choice");
      c.permissions.delete(action.id); c.snapshot.permissions = c.snapshot.permissions.filter((x) => x.id !== action.id);
      p.resolve({ outcome: { outcome: "selected", optionId: action.optionId } });
    } else if (action.type === "cancel") {
      if (c.snapshot.status === "running") { settle(c); await agent.notify(methods.agent.session.cancel, { sessionId: c.sessionId }); }
    } else if (action.type === "set-config") {
      if (c.snapshot.status !== "ready") throw new Error("Cannot change configuration while busy");
      const option = c.snapshot.configOptions.find((x) => x.id === action.configId);
      if (!option?.options.some((x) => x.value === action.value)) throw new Error("Configuration option or value is unavailable");
      c.snapshot.status = "configuring";
      try { const r = await agent.request(methods.agent.session.setConfigOption, { sessionId: c.sessionId, configId: action.configId, value: action.value }); c.snapshot.configOptions = normalize(r.configOptions); if (option.id === "model" || option.category === "model") delete c.snapshot.contextUsage; if (!dead && !c.deleted) c.snapshot.status = "ready"; }
      catch (e) { if (!dead) c.snapshot.status = "ready"; throw e; }
    } else if (action.type === "logout") {
      if (!initialized?.agentCapabilities?.auth?.logout || [...contexts.values()].some((x) => ["running", "authenticating", "configuring", "connecting"].includes(x.snapshot.status))) throw new Error("Sign-out unavailable while busy");
      loggingOut = true;
      try {
        await agent.request(methods.agent.logout, {});
        for (const x of contexts.values()) { settle(x); x.snapshot.status = "auth-required"; delete x.snapshot.login; }
      } finally { loggingOut = false; }
    } else throw new Error("Unknown action");
  }
  async function session(threadId) {
    if (!UUID.test(threadId)) throw new Error("Invalid thread id");
    if (loggingOut || quiescing || dead || deleted.has(threadId)) throw Error("Disconnected");
    if (contexts.has(threadId)) return contexts.get(threadId).public;
    const c = { snapshot: { status: "connecting", messages: [], permissions: [], configOptions: [] }, permissions: new Map(), promptIds: new Set(), cwd: `${root}/${threadId}/repo`, sessionFile: `${root}/${threadId}/acp-session` };
    c.public = { snapshot: c.snapshot, act: (a) => act(c, a) };
    contexts.set(threadId, c);
    c.public.ready = init.then(() => open(c)).catch((e) => {
      fail(c, e, c.openOperation);
      if (authentication && c.snapshot.status === "auth-required") {
        c.snapshot.status = "authenticating";
        if (login) c.snapshot.login = login;
      }
    });
    await Promise.resolve();
    return c.public;
  }
  return { session, isAlive: () => !dead,
    activity: () => Object.fromEntries([...contexts].map(([id, { snapshot: s, turn }]) => [id, {
      status: s.status,
      attention: s.permissions.length > 0 || Boolean(s.login),
      turn: turn ?? s.messages.findLast((m) => m.role === "user")?.id,
    }])),
    async deleteSession(threadId) {
    if (!UUID.test(threadId)) throw new Error("Invalid thread id");
    if (quiescing) throw Error("Disconnected");
    deleted.add(threadId);
    const c = contexts.get(threadId); if (!c) return;
    c.deleted = true; settle(c); contexts.delete(threadId); if (c.sessionId) { routes.delete(c.sessionId); if (c.snapshot.status === "running") await agent.notify(methods.agent.session.cancel, { sessionId: c.sessionId }); }
    await c.public.ready;
    await c.prompt;
    if (c.sessionId) routes.delete(c.sessionId);
  }, async quiesce() {
    if (quiesced) return true;
    if (quiescing) return false;
    if (dead) {
      await stopChildTree(child);
      await connection.close();
      quiesced = true;
      return true;
    }
    quiescing = true; // Fence session/action/delete before waiting on readiness races.
    await Promise.all([...contexts.values()].map((c) => c.public.ready));
    const busy = authentication || loggingOut || loginResolve || [...contexts.values()].some((c) =>
      ["running", "configuring", "connecting", "authenticating"].includes(c.snapshot.status) ||
      c.permissions.size > 0 || Boolean(c.snapshot.login));
    if (busy) { quiescing = false; return false; }
    try { await authCheckpoint?.sync(); }
    catch { quiescing = false; return false; }
    for (const c of contexts.values()) {
      if (c.freshSession && !c.turn)
        try { await unlink(c.sessionFile); } catch (e) { if (e.code !== "ENOENT") { quiescing = false; throw e; } }
    }
    dead = true;
    if (loginResolve) loginResolve({ action: "cancel" });
    for (const c of contexts.values()) settle(c);
    try {
      await stopChildTree(child);
      await connection.close();
      quiesced = true;
      return true;
    } finally { quiescing = false; }
  }, async close() { dead = true; if (loginResolve) loginResolve({ action: "cancel" }); for (const c of contexts.values()) settle(c); await stopChildTree(child); await connection.close(); } };
}

if (import.meta.main) {
  const checkpoint = createAuthCheckpoint({ path: `${process.env.CODEX_HOME}/auth.json`, url: process.env.AGENTFLARE_AUTH_CALLBACK, token: process.env.AGENTFLARE_AUTH_CAPABILITY });
  let callback;
  const bridge = createUserBridge({ authCheckpoint: checkpoint, onSettled: () => callback?.settled() });
  callback = createCheckpointLoop({
    url: process.env.AGENTFLARE_WORKSPACE_CALLBACK,
    token: process.env.AGENTFLARE_AUTH_CAPABILITY,
    payload: () => ({}),
    // Quiet saved runtimes must stop calling the DO so its idle timer can expire.
    // A new POST or a settled turn re-arms the loop.
    shouldContinue: () => bridge.isAlive() && Object.values(bridge.activity()).some(
      (s) => ["running", "configuring", "connecting", "authenticating"].includes(s.status)),
  });
  const server = Bun.serve({
    hostname: "0.0.0.0", // Reachable only through the authenticated Worker/DO.
    port: 8766,
    maxRequestBodySize: 2_100_000,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response(null, { status: bridge.isAlive() ? 204 : 503 });
      if (path === "/activity" && request.method === "GET")
        return Response.json(bridge.activity(), { headers: { "Cache-Control": "no-store" } });
      if (path === "/quiesce" && request.method === "POST") {
        try { return new Response(null, { status: await bridge.quiesce() ? 204 : 409 }); }
        catch { return new Response(null, { status: 409 }); }
      }
      const match = path.match(/^\/acp\/([^/]+)$/);
      if (!match || !UUID.test(match[1])) return new Response(null, { status: 404 });
      const threadId = match[1];
      let target;
      try {
        if (request.method === "DELETE") {
          await bridge.deleteSession(threadId);
          return new Response(null, { status: 204 });
        }
        target = await bridge.session(threadId);
      } catch {
        return Response.json({ error: "ACP session could not be opened." }, { status: 409 });
      }
      if (request.method === "POST") {
        try {
          await target.act(await request.json());
          callback?.settled();
        } catch (error) {
          return Response.json(
            { error: error.message === "Sign-out unavailable while busy" ? "Stop all running Codex threads before signing out." : "ACP action could not be applied." },
            { status: 409 },
          );
        }
      } else if (request.method !== "GET")
        return new Response(null, { status: 405 });
      let authPersistence;
      if (checkpoint) {
        try { await checkpoint.sync(); authPersistence = "saved"; }
        catch { authPersistence = "pending"; }
      }
      return Response.json({ ...target.snapshot, authScope: "user", authPersistence }, {
        headers: { "Cache-Control": "no-store" },
      });
    },
  });
  process.on("SIGTERM", () => {
    checkpoint?.stop();
    callback?.stop();
    server.stop(true);
    void bridge.close().finally(() => process.exit(0));
  });
}
