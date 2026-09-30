export type AcpMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  status?: string;
};

export type AcpSnapshot = {
  status:
    | "disconnected"
    | "connecting"
    | "auth-required"
    | "authenticating"
    | "ready"
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
};

export type AcpAction =
  | { type: "connect" }
  | { type: "authenticate" }
  | { type: "prompt"; text: string; requestId: string }
  | { type: "cancel" }
  | { type: "permission"; id: string; optionId: string }
  | { type: "login-response"; id: string; action: "accept" | "cancel" }
  | { type: "logout" };
