import type { AcpSnapshot } from "./acp";
import {
  readSnapshotUpdate,
  type SnapshotCursor,
  type SnapshotUpdate,
} from "../../sandbox/acp/snapshot-transport.mjs";

export type AcpReadCursor = SnapshotCursor<AcpSnapshot>;
export type AcpReadUpdate = SnapshotUpdate<AcpSnapshot>;
export const readAcpUpdate = readSnapshotUpdate<AcpSnapshot>;

export function acpReadPath(id: string, cursor?: AcpReadCursor) {
  return `/threads/${id}/runtime/acp?transport=delta${cursor ? `&revision=${encodeURIComponent(cursor.revision)}` : ""}`;
}
