import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Serve WASM from our own origin instead of relying on bundler asset relocation.
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await copyFile(
  fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm")),
  new URL("../public/ghostty-vt.wasm", import.meta.url),
);
