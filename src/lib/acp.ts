export type AcpMessage = {
  id: string;
  role: "user" | "assistant" | "thought" | "tool";
  text: string;
  status?: string;
};

export type AcpSnapshot = {
  authScope?: "user";
  authPersistence?: "saved" | "pending";
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
  contextUsage?: { used: number; size: number };
};

export type AcpAction =
  | { type: "connect" }
  | { type: "authenticate" }
  | { type: "prompt"; text: string; requestId: string }
  | { type: "set-config"; configId: string; value: string }
  | { type: "cancel" }
  | { type: "permission"; id: string; optionId: string }
  | { type: "login-response"; id: string; action: "accept" | "cancel" }
  | { type: "logout" };
