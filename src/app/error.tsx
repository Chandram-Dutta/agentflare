"use client";

import { Button } from "@/components/ui/button";

export default function PageError() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6 text-sm">
      <h1>Unable to load this page</h1>
      <p role="alert" className="text-muted-foreground">
        The server could not load your workspace or verify your session. Please
        retry.
      </p>
      <Button variant="outline" onClick={() => window.location.reload()}>
        Retry
      </Button>
    </main>
  );
}
