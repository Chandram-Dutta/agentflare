import { z } from "zod";

export const attachmentLimit = 2_000_000;
export const attachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(64000) }),
  z.strictObject({
    type: z.enum(["image", "audio"]),
    mimeType: z.string().min(1).max(128),
    uri: z.string().max(2048).optional(),
    data: z
      .string()
      .max(attachmentLimit)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  }),
  z.strictObject({
    type: z.literal("resource"),
    resource: z.union([
      z.strictObject({
        uri: z.string().max(2048),
        mimeType: z.string().max(128).optional(),
        text: z.string().max(64000),
      }),
      z.strictObject({
        uri: z.string().max(2048),
        mimeType: z.string().max(128).optional(),
        blob: z
          .string()
          .max(attachmentLimit)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      }),
    ]),
  }),
  z.strictObject({
    type: z.literal("resource_link"),
    uri: z.string().min(1).max(2048),
    name: z.string().min(1).max(256),
    mimeType: z.string().max(128).optional(),
    title: z.string().max(256).optional(),
    description: z.string().max(2000).optional(),
  }),
]);

export const promptActionSchema = z
  .strictObject({
    type: z.literal("prompt"),
    text: z.string().trim().max(16000),
    requestId: z.string().min(1).max(128),
    attachments: z.array(attachmentSchema).max(4).optional(),
  })
  .refine(
    (action) => Boolean(action.text || action.attachments?.length),
    "A message or attachment is required.",
  )
  .refine(
    (action) =>
      JSON.stringify(action.attachments ?? []).length <= attachmentLimit,
    "Attachments exceed the size limit.",
  );

export function resourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Non-web resources are displayed as labels. */
  }
}

export function mediaUrl(
  type: "image" | "audio",
  mimeType: string,
  data: string,
): string | undefined {
  const allowed =
    type === "image"
      ? ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]
      : [
          "audio/wav",
          "audio/x-wav",
          "audio/mpeg",
          "audio/mp3",
          "audio/ogg",
          "audio/webm",
          "audio/mp4",
          "audio/flac",
        ];
  if (
    allowed.includes(mimeType) &&
    data.length <= attachmentLimit &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    return `data:${mimeType};base64,${data}`;
}
