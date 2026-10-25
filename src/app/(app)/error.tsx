"use client";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/misc";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Alert tone="danger" title="Something went wrong">
        The page could not be loaded. Please try again{error.digest ? ` (reference ${error.digest})` : ""}.
      </Alert>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
