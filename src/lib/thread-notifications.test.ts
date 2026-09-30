import { expect, test } from "bun:test";
import type { AcpActivity } from "./acp";
import {
  notificationKind,
  showThreadNotification,
} from "./thread-notifications";

const running: AcpActivity = {
  status: "running",
  attention: false,
  turn: "t1",
};
const finished: AcpActivity = { ...running, status: "ready" };

test("only live completion and attention changes notify, including a turn between polls", () => {
  expect(notificationKind(undefined, finished)).toBeUndefined();
  expect(
    notificationKind(undefined, { ...running, attention: true }),
  ).toBeUndefined();
  expect(notificationKind(running, finished)).toBe("finished");
  expect(notificationKind(finished, finished)).toBeUndefined();
  expect(notificationKind(finished, { ...finished, turn: "t2" })).toBe(
    "finished",
  );
  expect(
    notificationKind(running, { ...running, status: "error" }),
  ).toBeUndefined();
  expect(
    notificationKind(running, { status: "ready", attention: false }),
  ).toBeUndefined();
  expect(
    notificationKind(running, {
      ...running,
      attention: true,
      attentionId: "p1",
    }),
  ).toBe("attention");
  const approval = { ...running, attention: true, attentionId: "p1" };
  expect(notificationKind(approval, approval)).toBeUndefined();
  expect(notificationKind(approval, { ...approval, attentionId: "p2" })).toBe(
    "attention",
  );
});

test("browser delivery requires an inactive tab, secure context, and permission; clicks open the thread", () => {
  const keys = ["window", "document", "Notification"] as const;
  const original = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  let focused = 0;
  let opened = 0;
  const created: FakeNotification[] = [];
  class FakeNotification {
    static permission = "granted";
    closed = false;
    onclick?: () => void;
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      created.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const browser = {
    Notification: FakeNotification,
    isSecureContext: true,
    focus: () => focused++,
  };
  let hasFocus = true;
  const document = { hidden: true, hasFocus: () => hasFocus };
  for (const [key, value] of Object.entries({
    window: browser,
    document,
    Notification: FakeNotification,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  const event = { threadId: "a", kind: "finished" as const };
  const show = () =>
    showThreadNotification(event, "project / thread", () => opened++);
  try {
    document.hidden = false;
    expect(show()).toBeUndefined();
    document.hidden = true;
    FakeNotification.permission = "denied";
    expect(show()).toBeUndefined();
    FakeNotification.permission = "granted";
    browser.isSecureContext = false;
    expect(show()).toBeUndefined();
    browser.isSecureContext = true;
    expect(created).toHaveLength(0);
    expect(show()).toBeDefined();
    expect(created[0].title).toBe("Codex finished");
    expect(created[0].options.body).toContain("project / thread");
    created[0].onclick?.();
    expect(created[0].closed).toBe(true);
    expect(focused).toBe(1);
    expect(opened).toBe(1);
    showThreadNotification(
      { ...event, kind: "attention" },
      "other thread",
      () => {},
    );
    expect(created[1].title).toBe("Codex needs your attention");
    // Another app can have focus while this browser tab remains visible.
    document.hidden = false;
    hasFocus = false;
    expect(show()).toBeDefined();
    expect(created).toHaveLength(3);
    hasFocus = true;
    expect(show()).toBeUndefined();
    expect(created).toHaveLength(3);
    document.hidden = true;
    Object.defineProperty(globalThis, "Notification", {
      value: class {
        static permission = "granted";
        constructor() {
          throw Error("unsupported constructor");
        }
      },
      configurable: true,
    });
    expect(show()).toBeUndefined();
  } finally {
    keys.forEach((key, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
