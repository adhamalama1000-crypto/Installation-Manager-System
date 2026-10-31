import { Banknote } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, DefinitionList } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import type { PaymentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Money for one visit. Technicians get a reduced DTO (what to collect, what they recorded). */
export async function PaymentCard({ payment: p, tz }: { payment: PaymentDTO; tz: string }) {
  const t = await getT();
  const L = t.locale;
  const egp = (n: number | null | undefined) => money(n, L);
  const method = (m: string) => t.dyn(`enums.paymentMethod.${m}`);
  const full = p.totalPrice !== undefined;
  const nothing = p.due === null && p.collectedAmount === null && !p.totalPrice && !p.depositAmount;
  return (
    <Card>
      <CardHeader title={t("paymentCard.title")} icon={<Banknote className="h-4 w-4" />} />
      <CardBody>
        {nothing ? (
          <p className="text-sm text-fg-subtle">{full ? t("paymentCard.noPriceManage") : t("paymentCard.noPrice")}</p>
        ) : (
          <DefinitionList
            className="sm:grid-cols-1"
            items={[
              ...(full
                ? [
                    { label: t("csv.totalPrice"), value: egp(p.totalPrice) },
                    {
                      label: t("csv.deposit"),
                      value: p.depositAmount ? `${egp(p.depositAmount)} · ${method(p.depositMethod!)}` : "—",
                    },
                    ...(p.extraFee ? [{ label: t("csv.extraFee"), value: egp(p.extraFee) }] : []),
                  ]
                : []),
              { label: t("paymentCard.toCollect"), value: <strong className="text-fg">{egp(p.due)}</strong> },
              {
                label: t("csv.collected"),
                value:
                  p.collectedAmount === null ? (
                    t("paymentCard.notRecorded")
                  ) : (
                    <span>
                      {egp(p.collectedAmount)}
                      {p.collectedMethod && ` · ${method(p.collectedMethod)}`}
                      {p.collectedBy && p.collectedAt && (
                        <span className="block text-xs text-fg-subtle">
                          {p.collectedBy.name} · {dateTime(p.collectedAt, tz, L)}
                        </span>
                      )}
                    </span>
                  ),
              },
              ...(p.collectedAmount !== null && p.balance !== null
                ? [{ label: t("paymentCard.stillOwed"), value: <span className={cn(p.balance > 0 && "font-medium text-danger")}>{egp(p.balance)}</span> }]
                : []),
              ...(p.custody && p.custody.status !== "VOID"
                ? [
                    {
                      label: t("csv.cash"),
                      value:
                        p.custody.status === "HELD" ? (
                          <Badge className="border-warning/40 bg-warning-soft text-fg">{t("paymentCard.withHolder", { name: p.custody.holder.name })}</Badge>
                        ) : (
                          <span>
                            <Badge className="border-success/40 bg-success-soft text-fg">{t("enums.custodyStatus.RECEIVED")}</Badge>
                            {p.custody.receivedBy && p.custody.receivedAt && (
                              <span className="block text-xs text-fg-subtle">
                                {p.custody.receivedBy.name} · {dateTime(p.custody.receivedAt, tz, L)}
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
