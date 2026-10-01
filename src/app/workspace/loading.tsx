export default function WorkspaceLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-dvh items-center justify-center text-xs text-muted-foreground"
    >
      Loading workspace…
    </div>
  );
}
