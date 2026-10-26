import { Banknote } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, DefinitionList } from "@/components/ui/misc";
import { PAYMENT_METHOD_LABELS, money } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import type { PaymentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Money for one visit. Technicians get a reduced DTO (what to collect, what they recorded). */
export function PaymentCard({ payment: p, tz }: { payment: PaymentDTO; tz: string }) {
  const full = p.totalPrice !== undefined;
  const nothing = p.due === null && p.collectedAmount === null && !p.totalPrice && !p.depositAmount;
  return (
    <Card>
      <CardHeader title="Payment" icon={<Banknote className="h-4 w-4" />} />
      <CardBody>
        {nothing ? (
          <p className="text-sm text-fg-subtle">No price recorded{full ? " - add it when editing the appointment" : ""}.</p>
        ) : (
          <DefinitionList
            className="sm:grid-cols-1"
            items={[
              ...(full
                ? [
                    { label: "Total price", value: money(p.totalPrice) },
                    {
                      label: "Deposit",
                      value: p.depositAmount ? `${money(p.depositAmount)} · ${PAYMENT_METHOD_LABELS[p.depositMethod!]}` : "—",
                    },
                    ...(p.extraFee ? [{ label: "Extra fee", value: money(p.extraFee) }] : []),
                  ]
                : []),
              { label: "To collect at the visit", value: <strong className="text-fg">{money(p.due)}</strong> },
              {
                label: "Collected",
                value:
                  p.collectedAmount === null ? (
                    "Not recorded yet"
                  ) : (
                    <span>
                      {money(p.collectedAmount)}
                      {p.collectedMethod && ` · ${PAYMENT_METHOD_LABELS[p.collectedMethod]}`}
                      {p.collectedBy && p.collectedAt && <span className="block text-xs text-fg-subtle">{p.collectedBy.name} · {dateTime(p.collectedAt, tz)}</span>}
                    </span>
                  ),
              },
              ...(p.collectedAmount !== null && p.balance !== null
                ? [{ label: "Still owed", value: <span className={cn(p.balance > 0 && "font-medium text-danger")}>{money(p.balance)}</span> }]
                : []),
              ...(p.custody && p.custody.status !== "VOID"
                ? [
                    {
                      label: "Cash",
                      value:
                        p.custody.status === "HELD" ? (
                          <Badge className="border-warning/40 bg-warning-soft text-fg">With {p.custody.holder.name}</Badge>
                        ) : (
                          <span>
                            <Badge className="border-success/40 bg-success-soft text-fg">Received</Badge>
                            {p.custody.receivedBy && p.custody.receivedAt && (
                              <span className="block text-xs text-fg-subtle">
                                {p.custody.receivedBy.name} · {dateTime(p.custody.receivedAt, tz)}
                              </span>
                            )}
                          </span>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}
