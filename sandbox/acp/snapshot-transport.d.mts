export type SnapshotUpdate<T> =
  | { revision: string; snapshot: T }
  | {
      revision: string;
      base: string;
      start: number;
      remove: number;
      insert: string;
    };
export type SnapshotCursor<T> = {
  revision: string;
  serialized: string;
  snapshot: T;
};
export function createSnapshotTransport<T>(limit?: number): {
  read(snapshot: T, base?: string): SnapshotUpdate<T>;
};
export function readSnapshotUpdate<T>(
  previous: SnapshotCursor<T> | undefined,
  wire: SnapshotUpdate<T>,
): SnapshotCursor<T>;
