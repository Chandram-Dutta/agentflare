// Separate key domain and authenticated runtime identity prevent a ciphertext
// copied from another user's durable object from becoming a valid login.
async function key(secret: string) {
  if (secret.length < 32) throw Error("Authentication secret is required.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("agentflare-codex-v1"),
      info: new Uint8Array(),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type SealedCredentials = { iv: string; ciphertext: string };

export async function sealCredentials(
  secret: string,
  owner: string,
  value: string,
): Promise<SealedCredentials> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) },
    await key(secret),
    new TextEncoder().encode(value),
  );
  return {
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

export async function openCredentials(
  secret: string,
  owner: string,
  value: SealedCredentials,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(value.iv, "base64"),
      additionalData: new TextEncoder().encode(owner),
    },
    await key(secret),
    Buffer.from(value.ciphertext, "base64"),
  );
  return new TextDecoder().decode(plaintext);
}
