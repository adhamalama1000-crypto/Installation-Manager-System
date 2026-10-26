"use client";

import { Banknote } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, DefinitionList } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import type { PaymentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Money for one visit. Technicians get a reduced DTO (what to collect, what they recorded). */
export function PaymentCard({ payment: p }: { payment: PaymentDTO }) {
  const { t, f, label } = useI18n();
  const full = p.totalPrice !== undefined;
  const nothing = p.due === null && p.collectedAmount === null && !p.totalPrice && !p.depositAmount;
  return (
    <Card>
      <CardHeader title={t("pay.title")} icon={<Banknote className="h-4 w-4" />} />
      <CardBody>
        {nothing ? (
          <p className="text-sm text-fg-subtle">{full ? t("pay.noPriceManage") : t("pay.noPrice")}</p>
        ) : (
          <DefinitionList
            className="sm:grid-cols-1"
            items={[
              ...(full
                ? [
                    { label: t("pay.total"), value: f.money(p.totalPrice) },
                    {
                      label: t("pay.deposit"),
                      value: p.depositAmount ? `${f.money(p.depositAmount)} · ${label("paymentMethod", p.depositMethod!)}` : "—",
                    },
                    ...(p.extraFee ? [{ label: t("pay.extraFee"), value: f.money(p.extraFee) }] : []),
                  ]
                : []),
              { label: t("pay.toCollect"), value: <strong className="text-fg">{f.money(p.due)}</strong> },
              {
                label: t("pay.collected"),
                value:
                  p.collectedAmount === null ? (
                    t("pay.notRecorded")
                  ) : (
                    <span>
                      {f.money(p.collectedAmount)}
                      {p.collectedMethod && ` · ${label("paymentMethod", p.collectedMethod)}`}
                      {p.collectedBy && p.collectedAt && (
                        <span className="block text-xs text-fg-subtle">
                          {p.collectedBy.name} · {f.dateTime(p.collectedAt)}
                        </span>
                      )}
                    </span>
                  ),
              },
              ...(p.collectedAmount !== null && p.balance !== null
                ? [{ label: t("pay.stillOwed"), value: <span className={cn(p.balance > 0 && "font-medium text-danger")}>{f.money(p.balance)}</span> }]
                : []),
              ...(p.custody && p.custody.status !== "VOID"
                ? [
                    {
                      label: t("pay.cash"),
                      value:
                        p.custody.status === "HELD" ? (
                          <Badge className="border-warning/40 bg-warning-soft text-fg">{t("pay.withHolder", { name: p.custody.holder.name })}</Badge>
                        ) : (
                          <span>
                            <Badge className="border-success/40 bg-success-soft text-fg">{t("pay.received")}</Badge>
                            {p.custody.receivedBy && p.custody.receivedAt && (
                              <span className="block text-xs text-fg-subtle">
                                {p.custody.receivedBy.name} · {f.dateTime(p.custody.receivedAt)}
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
