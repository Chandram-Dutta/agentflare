// Scripted protocol peer for bridge regression tests. No provider access.
import { createInterface } from "node:readline";
import { existsSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
if (process.argv.includes("slow-exit")) {
  process.on("SIGTERM", () => setTimeout(() => {
    writeFileSync("child-exited", "yes");
    process.exit(0);
  }, 50));
}
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const error = (id, code) =>
  send({ id, error: { code, message: "synthetic error" } });
const update = (update, sessionId = "saved-session") =>
  send({
    method: "session/update",
    params: { sessionId, update },
  });
let login;
let turn;
const turns = new Map();
const broken = process.argv.includes("broken");
const shared = process.argv.includes("shared");
const initialConfig = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "small",
    options: [
      { value: "small", name: "Small" },
      { value: "large", name: "Large" },
    ],
  },
  {
    type: "select",
    id: "reasoning_effort",
    name: "Reasoning",
    currentValue: "low",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  },
  {
    type: "select",
    id: "fast-mode",
    name: "Speed",
    description: "Faster responses with increased usage.",
    currentValue: "off",
    options: [{ value: "off", name: "Standard" }, { value: "on", name: "Fast" }],
  },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method) appendFileSync("requests", `${m.method}\n`);
  if (m.method === "initialize") {
    if (!m.params.clientCapabilities.elicitation.url) process.exit(2);
    reply(m.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, auth: { logout: {} }, promptCapabilities: { image: true, audio: true, embeddedContext: true } },
      authMethods: [{ id: "chat-gpt-device-code", name: "ChatGPT" }],
    });
  } else if (m.method === "session/new" || m.method === "session/load") {
    if (!existsSync("authenticated")) return error(m.id, -32000);
    const sessionId = m.method === "session/load" ? m.params.sessionId
      : shared ? `session-${m.params.cwd.split("/").at(-2)}` : "saved-session";
    if (m.method === "session/load") {
      if (existsSync("fail-load")) return send({ id: m.id, error: { code: -32603, message: "Internal error", data: { details: "no rollout found for thread id synthetic-private-detail" } } });
      if (broken) return error(m.id, -32002);
      update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "previous task" },
      }, sessionId);
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "restored answer" },
      }, sessionId);
    }
    reply(m.id, {
      sessionId,
      configOptions: initialConfig,
      modes: {
        currentModeId: "workspace-write",
        availableModes: [
          { id: "read-only", name: "Read only" },
          { id: "workspace-write", name: "Workspace write" },
          { id: "agent", name: "Agent" },
          { id: "agent-full-access", name: "Agent full access" },
        ],
      },
    });
  } else if (m.method === "authenticate") {
    login = m.id;
    send({
      id: "login",
      method: "elicitation/create",
      params: {
        requestId: m.id,
        mode: "url",
        elicitationId: "device",
        url: "https://auth.openai.com/device",
        message: "Enter ABCD-EFGH",
      },
    });
  } else if (m.id === "login") {
    if (m.result.action !== "accept") return error(login, -32000);
    setTimeout(() => {
      writeFileSync("authenticated", "synthetic");
      reply(login, {});
    }, 100);
  } else if (m.method === "session/prompt") {
    const sessionId = m.params.sessionId;
    if (m.params.prompt[0].text === "quota") return send({ id: m.id, error: { code: -32603, message: "Internal error", data: { codexErrorInfo: "usageLimitExceeded", message: "synthetic-private-detail" } } });
    if (m.params.prompt[0].text === "rich" || m.params.prompt[0].type !== "text") {
      for (const content of m.params.prompt) {
        update({
          sessionUpdate: "agent_message_chunk",
          ...(shared ? { messageId: `rich-${sessionId}` } : {}),
          content,
        }, sessionId);
      }
      update({ sessionUpdate: "tool_call", toolCallId: "rich-tool", title: "Preview", status: "completed",
        content: m.params.prompt.map(content => ({ type: "content", content })) }, sessionId);
      return reply(m.id, { stopReason: "end_turn" });
    }
    if (m.params.prompt[0].text === "crash") return process.exit(1);
    if (m.params.prompt[0].text === "long") {
      for (let i = 0; i < 4; i++) {
        update({
          sessionUpdate: "tool_call",
          toolCallId: `large-${i}`,
          title: "Output",
          status: "completed",
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "a".repeat(65000) },
        });
      }
      return reply(m.id, { stopReason: "end_turn" });
    }
    if (m.params.prompt[0].text === "telemetry") {
      update({ sessionUpdate: "usage_update", used: -3, size: 100 });
      update({ sessionUpdate: "usage_update", used: 25, size: 0 });
      update({ sessionUpdate: "usage_update", used: 13, size: 101 });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "explicit thought" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "visible answer" } });
      return reply(m.id, { stopReason: "end_turn" });
    }
    if (m.params.prompt[0].text === "config-event") {
      update({
        sessionUpdate: "config_option_update",
        configOptions: [{
          type: "select", id: "collaboration_mode", name: "Collaboration",
          currentValue: "plan", options: [{ value: "plan", name: "Plan" }],
        }],
      });
      return reply(m.id, { stopReason: "end_turn" });
    }
    turn = m.id;
    turns.set(sessionId, m.id);
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Inspecting ${shared ? sessionId : ""}` },
    }, sessionId);
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "files." },
    }, sessionId);
    const permissionId = shared ? `permission-${sessionId}` : "permission";
    send({
      id: permissionId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run tests?" },
        options: [
          { optionId: "deny", name: "Deny", kind: "reject_once" },
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
  } else if (m.method === "session/set_config_option") {
    if (process.argv.includes("crash-config")) return process.exit(1);
    if (m.params.configId !== "model" || m.params.value !== "large")
      return error(m.id, -32002);
    setTimeout(() => reply(m.id, {
      configOptions: [
        {
          type: "select", id: "model", name: "Model", category: "model",
          currentValue: "large", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }],
        },
        {
          type: "select", id: "reasoning_effort", name: "Reasoning",
          currentValue: "medium", options: [{ value: "medium", name: "Medium" }],
        },
      ],
    }), 50);
  } else if ((m.id === "permission" || (typeof m.id === "string" && m.id.startsWith("permission-session-"))) && (turn || shared)) {
    const sessionId = shared ? m.id.slice("permission-".length) : "saved-session";
    const activeTurn = shared ? turns.get(sessionId) : turn;
    if (!activeTurn) return;
    const outcome = m.result.outcome;
    update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: outcome.optionId === "allow" ? " Approved." : " Denied.",
      },
    }, sessionId);
    reply(activeTurn, { stopReason: "end_turn" });
    turns.delete(sessionId);
    turn = null;
  } else if (m.method === "session/cancel") {
    const pending = shared ? turns.get(m.params.sessionId) : turn;
    if (pending) reply(pending, { stopReason: "cancelled" });
    turns.delete(m.params.sessionId);
    if (!shared) turn = null;
  } else if (m.method === "logout") {
    rmSync("authenticated", { force: true });
    reply(m.id, {});
  }
});
