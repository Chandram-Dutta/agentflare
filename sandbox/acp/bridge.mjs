import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";

// The bridge owns the conversation, not a browser connection. Only this fixed
// application protocol is exposed to the Worker, never arbitrary ACP requests.
export function createBridge({
  command = ["/opt/agentflare/acp/node_modules/.bin/codex-acp"],
  cwd = "/workspace/repo",
  sessionFile = "/workspace/.agentflare/acp-session",
} = {}) {
  const snapshot = {
    status: "connecting",
    messages: [],
    permissions: [],
    configOptions: [],
  };
  const permissions = new Map();
  const elicitations = new Map();
  const promptIds = new Set();
  let sessionId;
  let currentMessage;
  let initialized;
  let dead = false;
  const child = spawn(command[0], command.slice(1), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Never inherit operator credentials into the model environment.
    env: {
      ...Object.fromEntries(
        ["PATH", "HOME", "LANG", "TERM", "CODEX_HOME"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]]],
        ),
      ),
      NO_BROWSER: "1",
    },
  });
  child.stderr.resume(); // Diagnostics may contain credentials; never forward.

  function settlePending() {
    for (const entry of permissions.values())
      entry.resolve({ outcome: { outcome: "cancelled" } });
    permissions.clear();
    snapshot.permissions = [];
    for (const entry of elicitations.values()) entry({ action: "cancel" });
    elicitations.clear();
    delete snapshot.login;
  }
  function fail(error) {
    settlePending();
    snapshot.status =
      !dead && error?.code === -32000 ? "auth-required" : "error";
    if (snapshot.status === "auth-required") delete snapshot.error;
    else
      snapshot.error =
        "Codex could not continue. Reconnect to reload this session.";
  }
  function append(role, text, id = crypto.randomUUID(), status) {
    if (text.length > 64000) snapshot.truncated = true;
    snapshot.messages.push({
      id,
      role,
      text: text.slice(0, 64000),
      ...(status ? { status } : {}),
    });
    boundTranscript();
  }
  function boundTranscript() {
    let size = snapshot.messages.reduce((n, m) => n + m.text.length, 0);
    while (
      snapshot.messages.length > 1 &&
      (size > 128000 || snapshot.messages.length > 300)
    ) {
      size -= snapshot.messages.shift().text.length;
      snapshot.truncated = true;
    }
  }
  function normalizeConfigOptions(configOptions, modes) {
    const source = Array.isArray(configOptions) ? configOptions : [];
    const normalized = source.flatMap((option) => {
      if (
        option?.type !== "select" ||
        typeof option.id !== "string" ||
        typeof option.name !== "string" ||
        typeof option.currentValue !== "string" ||
        !Array.isArray(option.options)
      )
        return [];
      const choices = option.options.flatMap((entry) =>
        Array.isArray(entry?.options) ? entry.options : [entry],
      );
      const options = choices.flatMap((choice) =>
        typeof choice?.value === "string" && typeof choice.name === "string"
          ? [{
              value: choice.value,
              name: choice.name,
              ...(typeof choice.description === "string"
                ? { description: choice.description }
                : {}),
            }]
          : [],
      );
      if (!options.some((choice) => choice.value === option.currentValue))
        return [];
      return [{
        id: option.id,
        name: option.name,
        ...(typeof option.description === "string"
          ? { description: option.description }
          : {}),
        ...(typeof option.category === "string"
          ? { category: option.category }
          : {}),
        currentValue: option.currentValue,
        options,
      }];
    });
    if (normalized.some((option) => option.id === "mode") || !modes)
      return normalized;
    if (
      typeof modes.currentModeId !== "string" ||
      !Array.isArray(modes.availableModes)
    )
      return normalized;
    const options = modes.availableModes.flatMap((mode) =>
      typeof mode?.id === "string" && typeof mode.name === "string"
        ? [{ value: mode.id, name: mode.name,
            ...(typeof mode.description === "string" ? { description: mode.description } : {}) }]
        : [],
    );
    return options.some((choice) => choice.value === modes.currentModeId)
      ? [{ id: "mode", name: "Mode", category: "mode", currentValue: modes.currentModeId, options }, ...normalized]
      : normalized;
  }
  function update({ update: u }) {
    if (
      u.sessionUpdate === "agent_message_chunk" ||
      u.sessionUpdate === "user_message_chunk" ||
      u.sessionUpdate === "agent_thought_chunk"
    ) {
      const role =
        u.sessionUpdate === "agent_message_chunk"
          ? "assistant"
          : u.sessionUpdate === "agent_thought_chunk" ? "thought" : "user";
      if (u.content?.type !== "text") return;
      const last = snapshot.messages.at(-1);
      if (last && last.id === currentMessage && last.role === role) {
        if (last.text.length + u.content.text.length > 64000)
          snapshot.truncated = true;
        last.text = (last.text + u.content.text).slice(0, 64000);
      } else {
        currentMessage = crypto.randomUUID();
        append(role, u.content.text, currentMessage);
      }
    } else if (u.sessionUpdate === "config_option_update") {
      const previousModel = snapshot.configOptions.find(
        (option) => option.id === "model" || option.category === "model",
      )?.currentValue;
      snapshot.configOptions = normalizeConfigOptions(u.configOptions);
      const nextModel = snapshot.configOptions.find(
        (option) => option.id === "model" || option.category === "model",
      )?.currentValue;
      if (previousModel !== nextModel) delete snapshot.contextUsage;
    } else if (u.sessionUpdate === "current_mode_update") {
      const mode = snapshot.configOptions.find((option) => option.id === "mode");
      if (mode?.options.some((choice) => choice.value === u.currentModeId))
        mode.currentValue = u.currentModeId;
    } else if (u.sessionUpdate === "usage_update") {
      if (
        Number.isFinite(u.used) && u.used >= 0 &&
        Number.isFinite(u.size) && u.size > 0
      ) snapshot.contextUsage = { used: u.used, size: u.size };
    } else if (
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update"
    ) {
      currentMessage = undefined;
      let item = snapshot.messages.find(
        (m) => m.role === "tool" && m.id === u.toolCallId,
      );
      if (!item) {
        append(
          "tool",
          u.title ?? "Tool call",
          u.toolCallId,
          u.status ?? "pending",
        );
        item = snapshot.messages.at(-1);
      }
      if (u.title) item.text = u.title.slice(0, 64000);
      if (u.status) item.status = u.status;
      const text = u.content
        ?.filter((c) => c.type === "content" && c.content?.type === "text")
        .map((c) => c.content.text)
        .join("\n");
      if (text)
        item.text = `${u.title ?? item.text.split("\n")[0]}\n${text}`.slice(
          0,
          64000,
        );
    }
    boundTranscript();
  }

  const connection = client({ name: "agentflare" })
    .onNotification(methods.client.session.update, (ctx) => update(ctx.params))
    .onRequest(
      methods.client.elicitation.create,
      (ctx) =>
        new Promise((resolve) => {
          const p = ctx.params;
          let url;
          try {
            url = new URL(p.url);
          } catch {
            /* reject below */
          }
          if (
            snapshot.status !== "authenticating" ||
            p.mode !== "url" ||
            url?.protocol !== "https:" ||
            url.username ||
            url.password ||
            !["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
            elicitations.size > 0
          )
            return resolve({ action: "cancel" });
          elicitations.set(p.elicitationId, resolve);
          snapshot.login = {
            id: p.elicitationId,
            url: url.href,
            message: p.message.slice(0, 2000),
          };
        }),
    )
    .onNotification(methods.client.elicitation.complete, (ctx) => {
      if (snapshot.login?.id === ctx.params.elicitationId)
        delete snapshot.login;
    })
    .onRequest(
      methods.client.session.requestPermission,
      (ctx) =>
        new Promise((resolve) => {
          const p = ctx.params;
          if (
            snapshot.status !== "running" ||
            permissions.size >= 32 ||
            !p.options.length
          )
            return resolve({ outcome: { outcome: "cancelled" } });
          const id = crypto.randomUUID();
          const options = p.options.map(({ optionId, name, kind }) => ({
            optionId,
            name,
            kind,
          }));
          permissions.set(id, { resolve, options });
          snapshot.permissions.push({ id, title: p.toolCall.title, options });
        }),
    )
    .connect(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );
  const agent = connection.agent;

  child.on("error", () => {
    dead = true;
    fail();
  });
  child.on("exit", () => {
    dead = true;
    fail();
  });

  async function openSession() {
    let saved;
    try {
      saved = (await readFile(sessionFile, "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    currentMessage = undefined;
    if (saved) {
      if (!initialized.agentCapabilities?.loadSession)
        throw new Error("Cannot resume");
      // History is replayed by ACP. Do not append it to the old transcript.
      snapshot.messages = [];
      const result = await agent.request(methods.agent.session.load, {
        sessionId: saved,
        cwd,
        mcpServers: [],
      });
      sessionId = saved;
      snapshot.configOptions = normalizeConfigOptions(result.configOptions, result.modes);
    } else {
      const result = await agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      sessionId = result.sessionId;
      snapshot.configOptions = normalizeConfigOptions(result.configOptions, result.modes);
      await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
      await writeFile(`${sessionFile}.tmp`, sessionId, { mode: 0o600 });
      await rename(`${sessionFile}.tmp`, sessionFile);
    }
    if (dead) throw new Error("Disconnected");
    snapshot.status = "ready";
    delete snapshot.error;
  }

  const ready = (async () => {
    initialized = await agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
      clientInfo: { name: "agentflare", version: "1" },
    });
    if (initialized.protocolVersion !== 1)
      throw new Error("Unsupported ACP version");
    await openSession();
  })().catch(fail);

  // Long-running actions return immediately. SDK requests and reverse requests
  // remain in the bridge while browsers may disconnect or refresh.
  async function act(action) {
    if (dead) throw new Error("Disconnected");
    if (action.type === "authenticate") {
      if (snapshot.status !== "auth-required")
        throw new Error("Not ready for login");
      if (
        !initialized.authMethods?.some((m) => m.id === "chat-gpt-device-code")
      )
        throw new Error("Device login unavailable");
      snapshot.status = "authenticating";
      delete snapshot.error;
      void agent
        .request(methods.agent.authenticate, {
          methodId: "chat-gpt-device-code",
        })
        .then(openSession)
        .catch(fail)
        .finally(() => {
          delete snapshot.login;
        });
    } else if (action.type === "login-response") {
      const resolve = elicitations.get(action.id);
      if (!resolve) {
        if (snapshot.login?.id !== action.id)
          throw new Error("Login request expired");
        if (action.action === "cancel") child.kill();
        return;
      }
      elicitations.delete(action.id);
      // Keep the code visible after opening the link; authentication may still
      // take minutes and the browser's external tab can be closed accidentally.
      resolve({ action: action.action });
      if (action.action === "cancel") delete snapshot.login;
    } else if (action.type === "permission") {
      const item = permissions.get(action.id);
      if (!item || !item.options.some((o) => o.optionId === action.optionId))
        throw new Error("Permission request expired or invalid choice");
      permissions.delete(action.id);
      snapshot.permissions = snapshot.permissions.filter(
        (p) => p.id !== action.id,
      );
      item.resolve({
        outcome: { outcome: "selected", optionId: action.optionId },
      });
    } else if (action.type === "prompt") {
      if (promptIds.has(action.requestId)) return;
      if (
        snapshot.status !== "ready" ||
        typeof action.text !== "string" ||
        !action.text.trim() ||
        action.text.length > 16000 ||
        typeof action.requestId !== "string"
      )
        throw new Error("Cannot send prompt");
      promptIds.add(action.requestId);
      if (promptIds.size > 1000)
        promptIds.delete(promptIds.values().next().value);
      append("user", action.text, action.requestId);
      currentMessage = undefined;
      snapshot.status = "running";
      void agent
        .request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: action.text }],
        })
        .then(() => {
          settlePending();
          if (!dead) snapshot.status = "ready";
        })
        .catch(fail);
    } else if (action.type === "set-config") {
      if (snapshot.status !== "ready")
        throw new Error("Cannot change configuration while busy");
      const option = snapshot.configOptions.find((item) => item.id === action.configId);
      if (!option || !option.options.some((item) => item.value === action.value))
        throw new Error("Configuration option or value is unavailable");
      snapshot.status = "configuring";
      try {
        const result = await agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: action.configId,
          value: action.value,
        });
        snapshot.configOptions = normalizeConfigOptions(result.configOptions);
        if (option.id === "model" || option.category === "model")
          delete snapshot.contextUsage;
        if (!dead) snapshot.status = "ready";
      } catch (error) {
        if (!dead) snapshot.status = "ready";
        throw error;
      }
    } else if (action.type === "cancel") {
      if (snapshot.status !== "running") return;
      settlePending();
      await agent.notify(methods.agent.session.cancel, { sessionId });
    } else if (action.type === "logout") {
      if (
        snapshot.status !== "ready" ||
        !initialized.agentCapabilities?.auth?.logout
      )
        throw new Error("Sign-out unavailable while busy");
      snapshot.status = "connecting";
      try {
        await agent.request(methods.agent.logout, {});
        snapshot.status = "auth-required";
        // Keep session metadata: logging out is not deleting conversation history.
      } catch (error) {
        fail(error);
      }
    } else throw new Error("Unknown action");
  }

  return {
    snapshot,
    act,
    ready,
    async close() {
      dead = true;
      settlePending();
      child.kill();
      await connection.close();
    },
  };
}

if (import.meta.main) {
  const bridge = createBridge();
  const server = Bun.serve({
    hostname: "0.0.0.0", // Reachable only through the authenticated Worker/DO.
    port: 8766,
    maxRequestBodySize: 100000,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/acp")
        return new Response(null, { status: 404 });
      if (request.method === "POST") {
        try {
          await bridge.act(await request.json());
        } catch {
          return Response.json(
            { error: "ACP action could not be applied." },
            { status: 409 },
          );
        }
      } else if (request.method !== "GET")
        return new Response(null, { status: 405 });
      return Response.json(bridge.snapshot, {
        headers: { "Cache-Control": "no-store" },
      });
    },
  });
  process.on("SIGTERM", () => {
    server.stop(true);
    void bridge.close().finally(() => process.exit(0));
  });
}
