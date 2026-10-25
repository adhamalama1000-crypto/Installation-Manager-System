import { ShieldOff } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";

export const metadata = { title: "Access denied" };

export default function AccessDeniedPage() {
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={<ShieldOff className="h-6 w-6" />}
        title="You don't have access to this page"
        description="Your account does not include permission for this section. Contact an administrator if you need access."
        action={<ButtonLink href="/" variant="outline">Back to dashboard</ButtonLink>}
      />
    </Card>
  );
}
