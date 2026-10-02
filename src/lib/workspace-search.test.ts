import { expect, test } from "bun:test";
import {
  matchesQuery,
  navigationShortcut,
  searchConversation,
  searchLines,
} from "./workspace-search";

test("search matches every word and returns actual matching source line", () => {
  expect(matchesQuery("Payments / Retry queue", "QUEUE pay")).toBe(true);
  expect(matchesQuery("Payments / Retry queue", "queue absent")).toBe(false);
  expect(
    searchLines(
      "src/a.ts",
      "nothing\nRetry payment\nretry user",
      "payment retry",
    ),
  ).toEqual([{ path: "src/a.ts", startLine: 2, text: "Retry payment" }]);
  expect(
    searchConversation(
      [
        { id: "1", role: "user", text: "Keep drafts" },
        { id: "2", role: "assistant", text: "Discard files" },
      ],
      "drafts",
    ).map((message) => message.id),
  ).toEqual(["1"]);
  expect(
    searchConversation([{ id: "1", role: "user", text: "Keep drafts" }], " "),
  ).toEqual([]);
});
test("shortcuts handle both platforms without overriding IME, alt or shifted keys", () => {
  const event = {
    key: "k",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
  };
  expect(navigationShortcut(event)).toBe("switch");
  expect(
    navigationShortcut({ ...event, ctrlKey: false, metaKey: true, key: "p" }),
  ).toBe("files");
  for (const patch of [
    { isComposing: true },
    { altKey: true },
    { shiftKey: true },
    { ctrlKey: false },
  ])
    expect(navigationShortcut({ ...event, ...patch })).toBeUndefined();
});
