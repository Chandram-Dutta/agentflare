import { expect, test } from "bun:test";
import { projectInput } from "./workspace";

test("project input normalizes GitHub repository roots", () => {
  expect(
    projectInput.parse({
      name: "widgets",
      repository: " https://github.com/acme/widgets.git/ ",
    }),
  ).toEqual({ name: "widgets", repository: "https://github.com/acme/widgets" });
});

test.each([
  "https://github.com.evil.test/acme/widgets",
  "https://token@github.com/acme/widgets",
  "https://github.com/acme/widgets/tree/main",
  "https://github.com/acme/widgets?token=secret",
  "https://github.com/acme/../widgets",
  "https://github.com/acme/%2e%2e",
  "https://github.com/acme/widgets\n--upload-pack=evil",
  "file:///etc/passwd",
])("rejects unsafe or ambiguous repository input: %s", (repository) => {
  expect(projectInput.safeParse({ name: "widgets", repository }).success).toBe(
    false,
  );
});
