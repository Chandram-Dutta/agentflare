// Scripted protocol peer for bridge regression tests. No provider access.
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const error = (id, code) =>
  send({ id, error: { code, message: "synthetic error" } });
const update = (update) =>
  send({
    method: "session/update",
    params: { sessionId: "saved-session", update },
  });
let login;
let turn;
const broken = process.argv.includes("broken");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (!m.params.clientCapabilities.elicitation.url) process.exit(2);
    reply(m.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, auth: { logout: {} } },
      authMethods: [{ id: "chat-gpt-device-code", name: "ChatGPT" }],
    });
  } else if (m.method === "session/new" || m.method === "session/load") {
    if (!existsSync("authenticated")) return error(m.id, -32000);
    if (m.method === "session/load") {
      if (broken) return error(m.id, -32002);
      update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "previous task" },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "restored answer" },
      });
    }
    reply(m.id, { sessionId: "saved-session" });
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
    turn = m.id;
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Inspecting " },
    });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "files." },
    });
    send({
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "saved-session",
        toolCall: { toolCallId: "tool-1", title: "Run tests?" },
        options: [
          { optionId: "deny", name: "Deny", kind: "reject_once" },
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
  } else if (m.id === "permission" && turn) {
    const outcome = m.result.outcome;
    update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: outcome.optionId === "allow" ? " Approved." : " Denied.",
      },
    });
    reply(turn, { stopReason: "end_turn" });
    turn = null;
  } else if (m.method === "session/cancel" && turn) {
    reply(turn, { stopReason: "cancelled" });
    turn = null;
  } else if (m.method === "logout") reply(m.id, {});
});
