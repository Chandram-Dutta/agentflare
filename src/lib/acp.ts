import type { ContentBlock } from "@agentclientprotocol/sdk";

export type AcpContent = ContentBlock;

export type AcpMessage = {
  id: string;
  role: "user" | "assistant" | "thought" | "tool";
  text: string;
  status?: string;
  content?: AcpContent[];
};

export type AcpActivity = {
  status: AcpSnapshot["status"];
  attention: boolean;
  attentionId?: string;
  turn?: string;
  turnCancelled?: boolean;
};

export type AcpSnapshot = {
  turnCancelled?: boolean;
  authScope?: "user";
  authPersistence?: "saved" | "pending";
  saved?: boolean;
  interrupted?: boolean;
  persistence?: {
    state: "saved" | "saving" | "error" | "disabled";
    savedAt?: string;
  };
  status:
    | "disconnected"
    | "connecting"
    | "auth-required"
    | "authenticating"
    | "ready"
    | "configuring"
    | "running"
    | "error";
  messages: AcpMessage[];
  truncated?: boolean;
  error?: string;
  login?: { id: string; url: string; message: string };
  permissions: {
    id: string;
    title: string;
    options: { optionId: string; name: string; kind: string }[];
  }[];
  configOptions?: {
    id: string;
    name: string;
    description?: string;
    category?: string;
    currentValue: string;
    options: { value: string; name: string; description?: string }[];
  }[];
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  contextUsage?: { used: number; size: number };
};

export type AcpAction =
  | { type: "connect" }
  | { type: "authenticate" }
  | {
      type: "prompt";
      text: string;
      requestId: string;
      attachments?: AcpContent[];
    }
  | { type: "set-config"; configId: string; value: string }
  | { type: "cancel" }
  | { type: "permission"; id: string; optionId: string }
  | { type: "login-response"; id: string; action: "accept" | "cancel" }
  | { type: "logout" };
