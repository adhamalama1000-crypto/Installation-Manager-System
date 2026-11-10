"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarClock,
  CalendarOff,
  CheckCircle2,
  Banknote,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  Package,
  Search,
  User as UserIcon,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import type { CustomerConfirmation, LeaveType, PaymentMethod, ProductCategory, VisitType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert, Badge, SalesTag } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { colorOrFallback } from "@/lib/colors";
import { CONFIRMATIONS, DURATION_PRESETS, PAYMENT_METHODS, PRODUCT_CATEGORIES, VISIT_TYPES, minutesLabel, money } from "@/lib/constants";
import { dayRangeLabel, timeKey, todayKey, weekdayOfKey } from "@/lib/time";
import { timeRange } from "@/lib/format";
import { checkMapUrl, extractCoordinates } from "@/lib/maps";
import type { AppointmentDTO, ConflictDTO, QuoteDTO, StatusDTO } from "@/lib/types";
import { CarWarning } from "./car-warning";
import type { FormValues } from "./form-values";
import { appointmentInputSchema, fieldErrorsFromZod } from "@/lib/validation";
import { cn } from "@/lib/utils";

type TechOption = { id: string; name: string; isActive: boolean };
type LeaveInfo = { type: LeaveType; startDate: string; endDate: string } | null;
type Suggestion = { suggested?: boolean; fits?: boolean; heldBy?: { name: string; until: string } | null; specialty?: string | null };
type Availability = Record<string, { available: boolean; conflicts: ConflictDTO[]; leave: LeaveInfo } & Suggestion>;
export type SavedLocation = {
  id: string;
  area: string | null;
  streetAddress: string | null;
  building: string | null;
  apartment: string | null;
  floor: string | null;
  accessInstructions: string | null;
  mapUrl: string | null;
  latitude: number | null;
  longitude: number | null;
};
type CustomerMatch = { id: string; name: string; phone: string; secondaryPhone: string | null; locations: SavedLocation[] };

const s = (v: string | null | undefined) => v ?? "";

function addMinutesToTime(time: string, minutes: number): { time: string; nextDay: number } {
  const [h, m] = time.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return { time: "--:--", nextDay: 0 };
  const total = h * 60 + m + minutes;
  const nextDay = Math.floor(total / 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`, nextDay };
}

export function AppointmentForm({
  mode,
  initial,
  appointmentId,
  version,
  technicians,
  statuses,
  salesOptions,
  currentUserId,
  canSeeInternalNotes,
  tz,
  originalCreator,
  initialLocations = [],
  closedWeekdays = [],
  isAdmin = false,
  canAssign = true,
  followUpOf,
  inspectionOnlyWeekdays = [],
}: {
  mode: "create" | "edit";
  initial: FormValues;
  appointmentId?: string;
  version?: number;
  technicians: TechOption[];
  statuses: StatusDTO[];
  /** Only for Admins creating on behalf of a Sales employee. */
  salesOptions?: { id: string; name: string; color: string | null }[];
  currentUserId: string;
  canSeeInternalNotes: boolean;
  tz: string;
  originalCreator?: { name: string; color: string | null; isActive: boolean };
  /** Saved sites of the customer being edited. */
  initialLocations?: SavedLocation[];
  /** The reader may choose technicians (appointments.assign); the server refuses changes otherwise. */
  canAssign?: boolean;
  /** Weekdays (0 = Sunday) that cannot be booked (Settings). */
  closedWeekdays?: number[];
  isAdmin?: boolean;
  /** Code of the visit this one follows up (create only). */
  followUpOf?: { id: string; code: string };
  /** Weekdays on which smart-home visits should only be inspections (Settings, Aura's Saturday rule). */
  inspectionOnlyWeekdays?: number[];
}) {
  const t = useT();
  const router = useRouter();
  const [v, setV] = useState<FormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<ConflictDTO[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [checking, setChecking] = useState(false);
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>(initialLocations);
  const [customDuration, setCustomDuration] = useState(!DURATION_PRESETS.includes(initial.durationMinutes));
  const [allowClosedDay, setAllowClosedDay] = useState(false);
  const [hold, setHold] = useState<{ until: string | null; error: string | null; pending: boolean } | null>(null);
  const [quote, setQuote] = useState<{ url: string; data: QuoteDTO } | null>(null);
  const [readingQuote, setReadingQuote] = useState(false);
  const requestId = useRef<string>("");
  const techSection = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestId.current = crypto.randomUUID();
  }, []);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setV((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setErrors((e) => {
      if (!e[key as string]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  };
  const setCustomer = (patch: Partial<FormValues["customer"]>) => {
    setV((prev) => ({ ...prev, customer: { ...prev.customer, ...patch } }));
    setDirty(true);
  };
  const setLocation = (patch: Partial<FormValues["location"]>) => {
    setV((prev) => ({ ...prev, location: { ...prev.location, ...patch } }));
    setDirty(true);
  };

  // Live technician availability for the chosen slot.
  useEffect(() => {
    if (!v.date || !/^\d{2}:\d{2}$/.test(v.startTime) || !(v.durationMinutes >= 15)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await api<{ technicians: ({ id: string; available: boolean; conflicts: ConflictDTO[]; leave: LeaveInfo } & Suggestion)[] }>("/api/appointments/availability", {
          method: "POST",
          body: {
            date: v.date,
            startTime: v.startTime,
            durationMinutes: v.durationMinutes,
            excludeAppointmentId: appointmentId ?? null,
            productCategory: v.productCategory || null,
            latitude: v.location.latitude || null,
            longitude: v.location.longitude || null,
            area: v.location.area || null,
          },
          signal: ctrl.signal,
        });
        setAvailability(
          Object.fromEntries(
            res.technicians.map((t2) => [
              t2.id,
              { available: t2.available, conflicts: t2.conflicts, leave: t2.leave ?? null, suggested: t2.suggested, fits: t2.fits, heldBy: t2.heldBy ?? null, specialty: t2.specialty ?? null },
            ]),
          ),
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") setAvailability(null);
      } finally {
        if (!ctrl.signal.aborted) setChecking(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [v.date, v.startTime, v.durationMinutes, appointmentId, v.productCategory, v.location.latitude, v.location.longitude, v.location.area]);

  /** Reads the quotation link from the company website (Aura api_quote). */
  async function readQuote() {
    setReadingQuote(true);
    try {
      const res = await api<{ quote: QuoteDTO }>("/api/quote", { method: "POST", body: { url: v.quoteUrl } });
      setQuote({ url: v.quoteUrl.trim(), data: res.quote });
      setErrors((e) => {
        const next = { ...e };
        delete next.quoteUrl;
        return next;
      });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setErrors((x) => ({ ...x, quoteUrl: err.fieldErrors.quoteUrl ?? err.message }));
    } finally {
      setReadingQuote(false);
    }
  }

  /** Fills empty fields from the quotation: customer, phone, price and the items to bring. */
  function applyQuote() {
    if (!quote) return;
    const q = quote.data;
    if (!v.customer.name.trim() && q.client) setCustomer({ name: q.client });
    if (!v.customer.phone.trim() && q.phone) setCustomer({ phone: q.phone });
    if (!v.totalPrice.trim() && q.total) set("totalPrice", q.total.replace(/,/g, ""));
    const lines = q.items.map((i) => `${i.qty} × ${i.name}${i.sku ? ` (${i.sku})` : ""}`).join("\n");
    if (lines && !v.requiredEquipment.includes(lines)) set("requiredEquipment", [v.requiredEquipment.trim(), lines].filter(Boolean).join("\n"));
  }

  const closedDay = /^\d{4}-\d{2}-\d{2}$/.test(v.date) && closedWeekdays.includes(weekdayOfKey(v.date));
  const toCollect = useMemo(() => {
    const n = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[,\s]/g, "")));
    const [total, deposit, fee] = [n(v.totalPrice), n(v.depositAmount), n(v.extraFee)];
    if ([total, deposit, fee].some((x) => x !== null && !Number.isFinite(x))) return null;
    if (total === null && fee === null) return null;
    return Math.round((Math.max(0, (total ?? 0) - (deposit ?? 0)) + (fee ?? 0)) * 100) / 100;
  }, [v.totalPrice, v.depositAmount, v.extraFee]);
  const selectedStatus = statuses.find((st) => st.id === v.statusId);
  const statusBlocks = selectedStatus ? selectedStatus.blocksSchedule : true;
  const end = addMinutesToTime(v.startTime, v.durationMinutes);
  const busySelected = useMemo(
    () => (statusBlocks && availability ? v.technicianIds.filter((id) => availability[id] && !availability[id]!.available) : []),
    [availability, v.technicianIds, statusBlocks],
  );

  /**
   * Aura's api_hold, done automatically: the technicians picked for this slot are held for 10
   * minutes while the booking is being made, so a colleague cannot book them meanwhile. Changing
   * the slot or the technicians replaces the hold, unticking everyone releases it, and leaving the
   * form lets it go. It is renewed while the form stays open. An edit page that is only being
   * looked at holds nothing: only a changed slot or a changed choice of technicians is held.
   */
  const holdIds = statusBlocks ? [...v.technicianIds].sort() : [];
  const holdKey = JSON.stringify([v.date, v.startTime, v.durationMinutes, holdIds]);
  const initialHoldKey = useRef(holdKey);
  const holdSeq = useRef(0);
  const holdingSomething = useRef(false);
  useEffect(() => {
    if (holdKey === initialHoldKey.current && !holdingSomething.current) return;
    const [date, startTime, durationMinutes, technicianIds] = JSON.parse(holdKey) as [string, string, number, string[]];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !(durationMinutes >= 15)) return;
    const seq = ++holdSeq.current;
    const take = async () => {
      if (technicianIds.length) setHold((h) => ({ until: h?.until ?? null, error: null, pending: true }));
      try {
        const res = await api<{ ok: boolean; until?: string | null; reason?: string }>("/api/holds", {
          method: "POST",
          body: { date, startTime, durationMinutes, technicianIds, excludeAppointmentId: appointmentId ?? null },
        });
        if (seq !== holdSeq.current) return; // a newer choice has been sent since
        holdingSomething.current = Boolean(res.ok && res.until);
        setHold(res.ok ? (res.until ? { until: res.until, error: null, pending: false } : null) : { until: null, error: res.reason ?? null, pending: false });
      } catch (e) {
        if (seq !== holdSeq.current) return;
        setHold({ until: null, error: e instanceof ApiError ? e.message : t("errors.network"), pending: false });
      }
    };
    const first = setTimeout(take, 400);
    const renew = technicianIds.length ? setInterval(take, 8 * 60_000) : undefined;
    return () => {
      clearTimeout(first);
      if (renew) clearInterval(renew);
    };
  }, [holdKey, appointmentId, t]);
  // Leaving the form (closing the tab, navigating away, or saving) lets the hold go. Saving also
  // releases it on the server; this covers abandoning the form.
  useEffect(() => {
    const release = () => {
      if (!holdingSomething.current) return;
      holdingSomething.current = false;
      void fetch("/api/holds", { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  const toggleTech = (id: string) => {
    const has = v.technicianIds.includes(id);
    set("technicianIds", has ? v.technicianIds.filter((x) => x !== id) : [...v.technicianIds, id]);
    setConflicts((c) => c.filter((x) => x.technicianId !== id));
  };

  function payload() {
    return {
      clientRequestId: mode === "create" ? requestId.current : undefined,
      version: mode === "edit" ? version : undefined,
      salesUserId: mode === "create" && salesOptions ? v.salesUserId || null : undefined,
      customer: v.customer,
      location: v.location,
      productCategory: v.productCategory,
      visitType: v.visitType || null,
      needsCar: v.needsCar,
      siteFoundation: v.productCategory === "SMART_HOME" ? v.siteFoundation || null : undefined,
      siteInternet: v.productCategory === "SMART_HOME" ? v.siteInternet || null : undefined,
      lockAt: v.lockAt || null,
      electrician: v.electrician || null,
      quoteUrl: v.quoteUrl.trim() || null,
      customerConfirmation: v.customerConfirmation,
      followUpOfId: mode === "create" ? v.followUpOfId : undefined,
      allowClosedDay: isAdmin && closedDay ? allowClosedDay : undefined,
      categoryOther: v.categoryOther,
      brand: v.brand,
      model: v.model,
      description: v.description,
      requiredEquipment: v.requiredEquipment,
      additionalNotes: v.additionalNotes,
      ...(canSeeInternalNotes ? { internalNotes: v.internalNotes } : {}),
      date: v.date,
      startTime: v.startTime,
      durationMinutes: v.durationMinutes,
      technicianIds: v.technicianIds,
      statusId: v.statusId || null,
      totalPrice: v.totalPrice,
      depositAmount: v.depositAmount,
      depositMethod: v.depositAmount.trim() ? v.depositMethod : null,
      extraFee: v.extraFee,
    };
  }

  function focusFirstError(errs: Record<string, string>) {
    const firstKey = Object.keys(errs)[0];
    if (!firstKey) return;
    const el = document.querySelector<HTMLElement>(`[data-field="${firstKey}"] input, [data-field="${firstKey}"] select, [data-field="${firstKey}"] textarea`);
    el?.focus();
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setConflicts([]);
    const body = payload();
    const check = appointmentInputSchema.safeParse(body);
    if (!check.success) {
      const errs = fieldErrorsFromZod(check.error);
      setErrors(errs);
      toast.error(t("errors.validation"));
      focusFirstError(errs);
      return;
    }
    setSaving(true);
    try {
      const res =
        mode === "create"
          ? await api<{ appointment: AppointmentDTO }>("/api/appointments", { method: "POST", body })
          : await api<{ appointment: AppointmentDTO }>(`/api/appointments/${appointmentId}`, { method: "PATCH", body });
      setDirty(false);
      // Keep what was read from the quotation link on the visit.
      if (quote && quote.url === v.quoteUrl.trim()) {
        await api(`/api/appointments/${res.appointment.id}/quote`, { method: "POST", body: { url: quote.url } }).catch(() => toast.warning(t("quote.notSaved")));
      }
      toast.success(t(mode === "create" ? "form.created" : "form.updated", { code: res.appointment.code }));
      router.push(`/appointments/${res.appointment.id}`);
      router.refresh();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(t("errors.unexpected"), 0, "UNKNOWN");
      if (apiErr.code === "SCHEDULING_CONFLICT") {
        setConflicts(apiErr.conflicts);
        toast.error(t("form.conflictToast"));
        techSection.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (apiErr.code === "VALIDATION_ERROR") {
        setErrors(apiErr.fieldErrors);
        toast.error(apiErr.message);
        focusFirstError(apiErr.fieldErrors);
      } else {
        setFormError(apiErr.message);
        toast.error(apiErr.message);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      setSaving(false);
    }
  }

  const err = (k: string) => errors[k];
  const mapCheck = v.location.mapUrl.trim() ? checkMapUrl(v.location.mapUrl) : null;
  const activeTechs = technicians.filter((x) => x.isActive || v.technicianIds.includes(x.id));

  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-6">
        {followUpOf && (
          <Alert tone="info" title={t("form.followUpTitle", { code: followUpOf.code })}>
            {t("form.followUpText")}
          </Alert>
        )}
        {formError && (
          <Alert tone="danger" title={t("common.couldNotSave")}>
            {formError}
            {formError === t("errors.stale") && (
              <button type="button" className="ms-2 font-medium text-brand-text underline" onClick={() => window.location.reload()}>
                {t("form.reload")}
              </button>
            )}
          </Alert>
        )}

        <Card>
          <CardHeader title={t("common.customer")} description={t("form.customerText")} icon={<UserIcon className="h-4 w-4" />} />
          <div className="space-y-4 p-5">
            <CustomerLookup
              selectedId={v.customer.id}
              onSelect={(c) => {
                setCustomer({ id: c.id, name: c.name, phone: c.phone, secondaryPhone: c.secondaryPhone ?? "" });
                const loc = c.locations[0];
                if (loc) {
                  setLocation({
                    id: loc.id,
                    area: s(loc.area),
                    streetAddress: s(loc.streetAddress),
                    building: s(loc.building),
                    apartment: s(loc.apartment),
                    floor: s(loc.floor),
                    accessInstructions: s(loc.accessInstructions),
                    mapUrl: s(loc.mapUrl),
                    latitude: loc.latitude != null ? String(loc.latitude) : "",
                    longitude: loc.longitude != null ? String(loc.longitude) : "",
                  });
                }
                setSavedLocations(c.locations);
              }}
              onClear={() => {
                setCustomer({ id: null });
                setLocation({ id: null });
                setSavedLocations([]);
              }}
            />
            {v.customer.id && (
              <p className="text-xs text-fg-subtle">{t("form.editingCustomer")}</p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div data-field="customer.name" className="sm:col-span-2">
                <Field label={t("form.customerName")} required error={err("customer.name")}>
                  {(p) => <Input {...p} value={v.customer.name} onChange={(e) => setCustomer({ name: e.target.value })} autoComplete="off" />}
                </Field>
              </div>
              <div data-field="customer.phone">
                <Field label={t("form.primaryPhone")} required error={err("customer.phone")}>
                  {(p) => <Input {...p} type="tel" inputMode="tel" value={v.customer.phone} onChange={(e) => setCustomer({ phone: e.target.value })} placeholder="+20 100 000 0000" dir="ltr" />}
                </Field>
              </div>
              <div data-field="customer.secondaryPhone">
                <Field label={t("form.secondaryPhone")} error={err("customer.secondaryPhone")} hint={t("common.optional")}>
                  {(p) => <Input {...p} type="tel" inputMode="tel" dir="ltr" value={v.customer.secondaryPhone} onChange={(e) => setCustomer({ secondaryPhone: e.target.value })} />}
                </Field>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title={t("form.locationTitle")} description={t("form.locationText")} icon={<MapPin className="h-4 w-4" />} />
          <div className="space-y-4 p-5">
            <SavedLocationPicker
              locations={savedLocations}
              selectedId={v.location.id}
              onPick={(loc) =>
                setLocation(
                  loc
                    ? {
                        id: loc.id,
                        area: s(loc.area),
                        streetAddress: s(loc.streetAddress),
                        building: s(loc.building),
                        apartment: s(loc.apartment),
                        floor: s(loc.floor),
                        accessInstructions: s(loc.accessInstructions),
                        mapUrl: s(loc.mapUrl),
                        latitude: loc.latitude != null ? String(loc.latitude) : "",
                        longitude: loc.longitude != null ? String(loc.longitude) : "",
                      }
                    : { id: null, area: "", streetAddress: "", building: "", apartment: "", floor: "", accessInstructions: "", mapUrl: "", latitude: "", longitude: "" },
                )
              }
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div data-field="location.streetAddress" className="sm:col-span-2">
                <Field label={t("form.address")} error={err("location.streetAddress")} hint={t("form.addressHint")}>
                  {(p) => <Input {...p} value={v.location.streetAddress} onChange={(e) => setLocation({ streetAddress: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.area">
                <Field label={t("location.area")} error={err("location.area")}>
                  {(p) => <Input {...p} value={v.location.area} onChange={(e) => setLocation({ area: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.building">
                <Field label={t("location.building")} error={err("location.building")}>
                  {(p) => <Input {...p} value={v.location.building} onChange={(e) => setLocation({ building: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.apartment">
                <Field label={t("form.apartment")} error={err("location.apartment")}>
                  {(p) => <Input {...p} value={v.location.apartment} onChange={(e) => setLocation({ apartment: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.floor">
                <Field label={t("form.floor")} error={err("location.floor")}>
                  {(p) => <Input {...p} value={v.location.floor} onChange={(e) => setLocation({ floor: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.accessInstructions" className="sm:col-span-2">
                <Field label={t("location.access")} error={err("location.accessInstructions")} hint={t("form.accessHint")}>
                  {(p) => <Textarea {...p} rows={2} value={v.location.accessInstructions} onChange={(e) => setLocation({ accessInstructions: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.mapUrl" className="sm:col-span-2">
                <Field
                  label={t("csv.mapLink")}
                  error={err("location.mapUrl")}
                  hint={
                    mapCheck && mapCheck.ok && !mapCheck.knownHost
                      ? t("form.mapUnknownHost", { host: mapCheck.host })
                      : t("form.mapHint")
                  }
                >
                  {(p) => (
                    <div className="flex gap-2">
                      <Input {...p} type="url" inputMode="url" value={v.location.mapUrl} onChange={(e) => setLocation({ mapUrl: e.target.value })} placeholder="https://maps.app.goo.gl/..." dir="ltr" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-10 w-10"
                        title={t("form.testLink")}
                        disabled={!mapCheck?.ok}
                        onClick={() => mapCheck?.ok && window.open(mapCheck.url, "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="sr-only">{t("form.testLink")}</span>
                      </Button>
                    </div>
                  )}
                </Field>
              </div>
              <div data-field="location.latitude">
                <Field label={t("historyFields.location.latitude")} error={err("location.latitude")} hint={t("common.optional")}>
                  {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={v.location.latitude} onChange={(e) => setLocation({ latitude: e.target.value })} placeholder="30.0444" />}
                </Field>
              </div>
              <div data-field="location.longitude">
                <Field label={t("historyFields.location.longitude")} error={err("location.longitude")} hint={t("common.optional")}>
                  {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={v.location.longitude} onChange={(e) => setLocation({ longitude: e.target.value })} placeholder="31.2357" />}
                </Field>
              </div>
            </div>
            {mapCheck?.ok && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  const c = extractCoordinates(v.location.mapUrl);
                  if (c) {
                    setLocation({ latitude: String(c.latitude), longitude: String(c.longitude) });
                    toast.success(t("form.coordsFilled"));
                  } else {
                    toast.info(t("form.noCoords"));
                  }
                }}
              >
                <Crosshair className="h-4 w-4" /> {t("form.fillCoords")}
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t("form.productTitle")} icon={<Package className="h-4 w-4" />} />
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <div data-field="productCategory">
              <Field label={t("form.category")} required error={err("productCategory")}>
                {(p) => (
                  <Select {...p} value={v.productCategory} onChange={(e) => set("productCategory", e.target.value as ProductCategory)}>
                    <option value="">{t("common.choose")}</option>
                    {PRODUCT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {t.dyn(`enums.productCategory.${c}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div data-field="visitType">
              <Field label={t("appointment.visitType")} error={err("visitType")}>
                {(p) => (
                  <Select {...p} value={v.visitType} onChange={(e) => set("visitType", e.target.value as VisitType | "")}>
                    <option value="">{t("common.notSpecified")}</option>
                    {VISIT_TYPES.map((vt) => (
                      <option key={vt} value={vt}>
                        {t.dyn(`enums.visitType.${vt}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div data-field="needsCar" className="sm:col-span-2">
              <Checkbox label={t("car.needsCar")} description={t("car.needsCarText")} checked={v.needsCar} onChange={(e) => set("needsCar", e.target.checked)} />
              {v.needsCar && <CarWarning date={v.date} time={v.startTime} latitude={v.location.latitude} longitude={v.location.longitude} area={v.location.area} excludeId={appointmentId} />}
            </div>
            <div data-field="lockAt">
              <Field label={t("booking.lockAt")} error={err("lockAt")}>
                {(p) => (
                  <Select {...p} value={v.lockAt} onChange={(e) => set("lockAt", e.target.value as FormValues["lockAt"])}>
                    <option value="">{t("common.notSpecified")}</option>
                    {(["COMPANY", "CUSTOMER", "UNDECIDED"] as const).map((x) => (
                      <option key={x} value={x}>
                        {t.dyn(`enums.lockAt.${x}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div data-field="electrician">
              <Field label={t("booking.electrician")} error={err("electrician")}>
                {(p) => (
                  <Select {...p} value={v.electrician} onChange={(e) => set("electrician", e.target.value as FormValues["electrician"])}>
                    <option value="">{t("common.notSpecified")}</option>
                    {(["CUSTOMER_PROVIDES", "COMPANY_PROVIDES", "NOT_NEEDED"] as const).map((x) => (
                      <option key={x} value={x}>
                        {t.dyn(`enums.electrician.${x}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {v.productCategory === "SMART_HOME" && (
              <>
                {(["siteFoundation", "siteInternet"] as const).map((key) => (
                  <div key={key} data-field={key}>
                    <Field label={t(key === "siteFoundation" ? "booking.siteFoundation" : "booking.siteInternet")} error={err(key)}>
                      {(p) => (
                        <Select {...p} value={v[key]} onChange={(e) => set(key, e.target.value as FormValues["siteFoundation"])}>
                          <option value="">{t("common.notSpecified")}</option>
                          {(["UNKNOWN", "NOT_READY", "READY"] as const).map((x) => (
                            <option key={x} value={x}>
                              {t.dyn(`enums.readiness.${key}.${x}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                ))}
                {(v.siteFoundation !== "READY" || v.siteInternet !== "READY") && (
                  <div className="sm:col-span-2">
                    <Alert tone="info">{t("booking.checkReadiness")}</Alert>
                  </div>
                )}
              </>
            )}
            <div data-field="quoteUrl" className="sm:col-span-2">
              <Field label={t("quote.link")} hint={t("quote.linkHint")} error={err("quoteUrl")}>
                {(p) => (
                  <div className="flex gap-2">
                    <Input {...p} dir="ltr" inputMode="url" value={v.quoteUrl} onChange={(e) => set("quoteUrl", e.target.value)} className="min-w-0 flex-1" />
                    <Button type="button" variant="outline" loading={readingQuote} disabled={!v.quoteUrl.trim()} onClick={readQuote}>
                      {t("quote.read")}
                    </Button>
                  </div>
                )}
              </Field>
              {quote && quote.url === v.quoteUrl.trim() && (
                <div className="mt-2 rounded-lg border border-line bg-surface-muted p-3 text-sm">
                  <p className="flex flex-wrap items-center justify-between gap-2 font-medium text-fg">
                    <span>
                      {quote.data.number ? <bdi className="font-mono">{quote.data.number}</bdi> : t("quote.title")} · {t("quote.items", { count: quote.data.count })}
                      {quote.data.total ? ` · ${quote.data.total}` : ""}
                    </span>
                    <Button type="button" size="sm" onClick={applyQuote}>
                      {t("quote.use")}
                    </Button>
                  </p>
                  <ul className="mt-1 list-disc ps-5 text-fg-muted">
                    {quote.data.items.slice(0, 8).map((i, k) => (
                      <li key={k}>
                        {i.qty} × <span dir="auto">{i.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {v.productCategory === "OTHER" ? (
              <div data-field="categoryOther">
                <Field label={t("form.categoryOther")} required error={err("categoryOther")}>
                  {(p) => <Input {...p} value={v.categoryOther} onChange={(e) => set("categoryOther", e.target.value)} />}
                </Field>
              </div>
            ) : null}
            <div data-field="brand">
              <Field label={t("csv.brand")} error={err("brand")}>
                {(p) => <Input {...p} value={v.brand} onChange={(e) => set("brand", e.target.value)} />}
              </Field>
            </div>
            <div data-field="model">
              <Field label={t("csv.model")} error={err("model")}>
                {(p) => <Input {...p} value={v.model} onChange={(e) => set("model", e.target.value)} />}
              </Field>
            </div>
            <div data-field="description" className="sm:col-span-2">
              <Field label={t("form.description")} error={err("description")}>
                {(p) => <Textarea {...p} rows={3} value={v.description} onChange={(e) => set("description", e.target.value)} />}
              </Field>
            </div>
            <div data-field="requiredEquipment" className="sm:col-span-2">
              <Field label={t("form.equipment")} error={err("requiredEquipment")}>
                {(p) => <Textarea {...p} rows={2} value={v.requiredEquipment} onChange={(e) => set("requiredEquipment", e.target.value)} />}
              </Field>
            </div>
            <div data-field="additionalNotes" className="sm:col-span-2">
              <Field label={t("form.additionalNotes")} error={err("additionalNotes")} hint={t("form.additionalNotesHint")}>
                {(p) => <Textarea {...p} rows={2} value={v.additionalNotes} onChange={(e) => set("additionalNotes", e.target.value)} />}
              </Field>
            </div>
            {canSeeInternalNotes && (
              <div data-field="internalNotes" className="sm:col-span-2">
                <Field label={t("form.internalNotes")} error={err("internalNotes")} hint={t("form.internalNotesHint")}>
                  {(p) => <Textarea {...p} rows={2} value={v.internalNotes} onChange={(e) => set("internalNotes", e.target.value)} />}
                </Field>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t("form.priceTitle")}
            description={t("form.priceText")}
            icon={<Banknote className="h-4 w-4" />}
          />
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <div data-field="totalPrice">
              <Field label={t("form.totalPrice")} error={err("totalPrice")}>
                {(p) => <Input {...p} inputMode="decimal" value={v.totalPrice} onChange={(e) => set("totalPrice", e.target.value)} placeholder={t("form.totalPricePlaceholder")} />}
              </Field>
            </div>
            <div data-field="extraFee">
              <Field label={t("form.extraFee")} error={err("extraFee")} hint={t("form.extraFeeHint")}>
                {(p) => <Input {...p} inputMode="decimal" value={v.extraFee} onChange={(e) => set("extraFee", e.target.value)} />}
              </Field>
            </div>
            <div data-field="depositAmount">
              <Field label={t("form.deposit")} error={err("depositAmount")}>
                {(p) => <Input {...p} inputMode="decimal" value={v.depositAmount} onChange={(e) => set("depositAmount", e.target.value)} />}
              </Field>
            </div>
            <div data-field="depositMethod">
              <Field label={t("historyFields.depositMethod")} error={err("depositMethod")}>
                {(p) => (
                  <Select {...p} value={v.depositMethod} disabled={!v.depositAmount.trim()} onChange={(e) => set("depositMethod", e.target.value as PaymentMethod)}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t.dyn(`enums.paymentMethod.${m}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {toCollect !== null && (
              <p className="text-sm text-fg-muted sm:col-span-2">
                {t("paymentCard.toCollect")}: <strong className="text-fg">{money(toCollect, t.locale)}</strong>
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-6 xl:sticky xl:top-20 xl:self-start">
        <Card id="schedule" className="scroll-mt-20">
          <CardHeader title={t("appointment.schedule")} description={t("form.timesIn", { tz })} icon={<CalendarClock className="h-4 w-4" />} />
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <div data-field="date">
              <Field label={t("common.date")} required error={err("date")}>
                {(p) => <Input {...p} type="date" value={v.date} onChange={(e) => set("date", e.target.value)} />}
              </Field>
            </div>
            {!isAdmin && /^\d{4}-\d{2}-\d{2}$/.test(v.date) && v.date < todayKey(tz) && (
              <div className="sm:col-span-2">
                <Alert tone="warning">{t("appointmentErrors.pastDate")}</Alert>
              </div>
            )}
            {/^\d{4}-\d{2}-\d{2}$/.test(v.date) && inspectionOnlyWeekdays.includes(weekdayOfKey(v.date)) && v.productCategory === "SMART_HOME" && v.visitType !== "INSPECTION" && (
              <div className="sm:col-span-2">
                <Alert tone="warning">{t("form.inspectionOnly", { day: t.dyn(`enums.weekday.${weekdayOfKey(v.date)}`) })}</Alert>
              </div>
            )}
            {closedDay && (
              <div className="sm:col-span-2">
                <Alert tone="warning" title={t("form.closedDay", { day: t.dyn(`enums.weekday.${weekdayOfKey(v.date)}`) })}>
                  {isAdmin ? (
                    <label className="mt-1 flex items-center gap-2">
                      <input type="checkbox" checked={allowClosedDay} onChange={(e) => setAllowClosedDay(e.target.checked)} className="h-4 w-4 accent-[var(--brand-strong)]" />
                      {t("form.bookClosedDay")}
                    </label>
                  ) : (
                    t("form.chooseAnotherDate")
                  )}
                </Alert>
              </div>
            )}
            <div data-field="startTime">
              <Field label={t("form.startTime")} required error={err("startTime")}>
                {(p) => <Input {...p} type="time" step={300} value={v.startTime} onChange={(e) => set("startTime", e.target.value)} />}
              </Field>
            </div>
            <div data-field="durationMinutes">
              <Field label={t("form.duration")} required error={err("durationMinutes")}>
                {(p) => (
                  <Select
                    {...p}
                    value={customDuration ? "custom" : String(v.durationMinutes)}
                    onChange={(e) => {
                      if (e.target.value === "custom") {
                        setCustomDuration(true);
                      } else {
                        setCustomDuration(false);
                        set("durationMinutes", Number(e.target.value));
                      }
                    }}
                  >
                    {DURATION_PRESETS.map((d) => (
                      <option key={d} value={d}>
                        {minutesLabel(d, t)}
                      </option>
                    ))}
                    <option value="custom">{t("form.custom")}</option>
                  </Select>
                )}
              </Field>
            </div>
            {customDuration ? (
              <div>
                <Field label={t("form.minutes")} required>
                  {(p) => (
                    <Input {...p} type="number" min={15} max={1440} step={15} value={v.durationMinutes || ""} onChange={(e) => set("durationMinutes", Number(e.target.value))} />
                  )}
                </Field>
              </div>
            ) : (
              <div className="flex flex-col justify-end">
                <p className="text-xs font-medium text-fg-muted">{t("form.endsAt")}</p>
                <p className="mt-1 flex h-10 items-center rounded-lg bg-surface-muted px-3 text-sm font-semibold tabular-nums">
                  {end.time}
                  {end.nextDay > 0 && <span className="ms-1 text-xs font-normal text-warning">({t("form.nextDayCount", { count: end.nextDay })})</span>}
                </p>
              </div>
            )}
            {customDuration && (
              <p className="text-sm text-fg-muted sm:col-span-2">
                {t("form.endsAt")} <span className="font-semibold tabular-nums text-fg">{end.time}</span>
                {end.nextDay > 0 && <span className="text-warning"> ({t("form.nextDay")})</span>}
              </p>
            )}
            <div data-field="statusId" className="sm:col-span-2">
              <Field label={t("common.status")} error={err("statusId")}>
                {(p) => (
                  <Select {...p} value={v.statusId} onChange={(e) => set("statusId", e.target.value)}>
                    {statuses
                      .filter((st) => st.isActive || st.id === initial.statusId)
                      .map((st) => (
                        <option key={st.id} value={st.id}>
                          {st.label}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>
            <div data-field="customerConfirmation" className="sm:col-span-2">
              <Field label={t("appointment.confirmation")} error={err("customerConfirmation")}>
                {(p) => (
                  <Select {...p} value={v.customerConfirmation} onChange={(e) => set("customerConfirmation", e.target.value as CustomerConfirmation)}>
                    {CONFIRMATIONS.map((c) => (
                      <option key={c} value={c}>
                        {t.dyn(`enums.confirmation.${c}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {mode === "create" && salesOptions ? (
              <div data-field="salesUserId" className="sm:col-span-2">
                <Field label={t("form.salesEmployee")} error={err("salesUserId")} hint={t("form.salesEmployeeHint")}>
                  {(p) => (
                    <Select {...p} value={v.salesUserId} onChange={(e) => set("salesUserId", e.target.value)}>
                      {salesOptions.map((so) => (
                        <option key={so.id} value={so.id}>
                          {so.name}
                          {so.id === currentUserId ? ` (${t("form.me")})` : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            ) : originalCreator ? (
              <div className="sm:col-span-2">
                <p className="text-xs font-medium text-fg-muted">{t("appointment.salesCreator")}</p>
                <div className="mt-1.5">
                  <SalesTag name={originalCreator.name} color={originalCreator.color} inactive={!originalCreator.isActive} />
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <div ref={techSection}>
        <Card>
          <CardHeader
            title={t("common.technicians")}
            description={checking ? t("form.checking") : statusBlocks ? t("form.availability") : t("form.noBlock")}
            icon={checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
          />
          <div className="space-y-3 p-5" data-field="technicianIds">
            {conflicts.length > 0 && (
              <Alert tone="danger" title={t("form.conflict")}>
                <ul className="mt-1 list-disc space-y-1 ps-4">
                  {conflicts.map((c) => (
                    <li key={`${c.technicianId}-${c.appointmentId}`}>
                      <strong className="text-fg">{c.technicianName}</strong>{" "}
                      {t("form.alreadyBooked", {
                        time: timeRange(c.startsAt, c.endsAt, tz),
                        code: c.appointmentCode,
                        customer: c.customerName ? `${t.locale === "ar" ? "،" : ","} ${c.customerName}` : "",
                      })}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">{t("form.conflictText")}</p>
              </Alert>
            )}
            {busySelected.length > 0 && conflicts.length === 0 && (
              <Alert tone="warning">
                {t(busySelected.every((id) => availability?.[id]?.leave) ? "form.selectedOnLeave" : "form.selectedBusy", {
                  names: busySelected.map((id) => technicians.find((x) => x.id === id)?.name).join(t.locale === "ar" ? "، " : ", "),
                  count: busySelected.length,
                })}
              </Alert>
            )}
            {err("technicianIds") && <Alert tone="danger">{t.msg(err("technicianIds"))}</Alert>}
            {activeTechs.length === 0 && <p className="text-sm text-fg-muted">{t("form.noTechnicians")}</p>}
            <ul className="space-y-2">
              {activeTechs.map((tech) => {
                const a = availability?.[tech.id];
                const selected = v.technicianIds.includes(tech.id);
                const busy = statusBlocks && a && !a.available;
                const conflicted = conflicts.some((c) => c.technicianId === tech.id);
                return (
                  <li key={tech.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                        selected ? "border-brand bg-brand-soft" : "border-line hover:bg-surface-muted",
                        (busy || conflicted) && selected && "border-danger bg-danger-soft",
                        busy && !selected && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-[var(--brand-strong)]"
                        checked={selected}
                        disabled={!canAssign || (busy && !selected) || (!tech.isActive && !selected)}
                        onChange={() => toggleTech(tech.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-fg">{tech.name}</span>
                          {!tech.isActive && <Badge>{t("common.inactive")}</Badge>}
                          {a?.suggested && <Badge className="bg-brand-soft text-brand-text">{t("holds.suggested")}</Badge>}
                          {a && a.fits === false && <span className="text-xs text-warning">{t("holds.notSpecialty")}</span>}
                          {a &&
                            (busy && a.leave ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                                <CalendarOff className="h-3.5 w-3.5" /> {t("form.onLeave")}
                              </span>
                            ) : busy ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                                <XCircle className="h-3.5 w-3.5" /> {t("form.busy")}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                                <CheckCircle2 className="h-3.5 w-3.5" /> {t("form.available")}
                              </span>
                            ))}
                        </span>
                        {a?.heldBy && (
                          <span className="mt-0.5 block text-xs text-fg-muted">{t("holds.heldBy", { name: a.heldBy.name, time: timeKey(a.heldBy.until, tz) })}</span>
                        )}
                        {busy && a!.leave && (
                          <span className="mt-0.5 block text-xs text-fg-muted">
                            {t.dyn(`enums.leaveType.${a!.leave.type}`)} · {dayRangeLabel(a!.leave.startDate, a!.leave.endDate, t.locale)}
                          </span>
                        )}
                        {busy &&
                          a!.conflicts.map((c) => (
                            <span key={c.appointmentId} className="mt-0.5 block text-xs text-fg-muted">
                              <bdi>{timeRange(c.startsAt, c.endsAt, tz)}</bdi> · <bdi>{c.appointmentCode}</bdi>
                              {c.customerName ? ` · ${c.customerName}` : ""}
                            </span>
                          ))}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {v.technicianIds.length === 0 ? (
              <p className="text-xs text-fg-subtle">{t("form.noTechnicianHint")}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs" role="status" aria-live="polite">
                {!statusBlocks ? null : hold?.error ? (
                  <span className="text-warning">{t.msg(hold.error)}</span>
                ) : hold?.pending ? (
                  <span className="inline-flex items-center gap-1 text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("holds.holding")}
                  </span>
                ) : hold?.until ? (
                  <span className="text-fg-muted">{t("holds.heldUntil", { time: timeKey(hold.until, tz) })}</span>
                ) : (
                  <span className="text-fg-subtle">{t("holds.autoHint")}</span>
                )}
              </div>
            )}
          </div>
        </Card>
        </div>

        <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-surface/95 p-4 backdrop-blur sm:mx-0 sm:rounded-xl sm:border xl:static xl:border-0 xl:bg-transparent xl:p-0">
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => router.back()} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" className="flex-[2]" loading={saving}>
              {mode === "create" ? t("form.create") : t("common.saveChanges")}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function CustomerLookup({
  selectedId,
  onSelect,
  onClear,
}: {
  selectedId: string | null;
  onSelect: (c: CustomerMatch) => void;
  onClear: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CustomerMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing results for short queries
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api<{ customers: CustomerMatch[] }>(`/api/customers/lookup?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        setResults(res.customers);
        setOpen(true);
      } catch {
        /* ignore */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => results.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={t("form.findCustomerPlaceholder")}
            aria-label={t("form.findCustomer")}
            className="ps-9"
          />
          {loading && <Loader2 className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-fg-subtle" />}
        </div>
        {selectedId && (
          <Button type="button" variant="outline" onClick={onClear} title={t("form.newCustomerTitle")}>
            <UserPlus className="h-4 w-4" /> <span className="hidden sm:inline">{t("form.newCustomer")}</span>
          </Button>
        )}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-pop">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-start hover:bg-surface-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(c);
                  setOpen(false);
                  setQ("");
                }}
              >
                <span className="text-sm font-medium text-fg">{c.name}</span>
                <span className="text-xs text-fg-muted">
                  <bdi dir="ltr">{c.phone}</bdi>
                  {c.locations[0] ? ` · ${[c.locations[0].building, c.locations[0].area].filter(Boolean).join("، ")}` : ""}
                  {c.locations.length > 1 ? ` · ${t("form.locationsCount", { count: c.locations.length })}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !loading && q.trim().length >= 2 && results.length === 0 && (
        <p className="mt-1 text-xs text-fg-subtle">{t("form.noCustomerFound")}</p>
      )}
    </div>
  );
}

function SavedLocationPicker({
  locations,
  selectedId,
  onPick,
}: {
  locations: SavedLocation[];
  selectedId: string | null;
  onPick: (loc: SavedLocation | null) => void;
}) {
  const t = useT();
  if (!locations.length) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-fg-muted">{t("form.savedLocations")}</p>
      <div className="flex flex-wrap gap-2">
        {locations.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onPick(l)}
            className={cn(
              "rounded-lg border px-3 py-2 text-start text-xs",
              selectedId === l.id ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted",
            )}
          >
            <span className="block font-medium text-fg">{[l.building, l.area].filter(Boolean).join("، ") || t("appointment.location")}</span>
            {[l.apartment && t("dayPlanText.apartment", { value: l.apartment }), l.floor && t("dayPlanText.floor", { value: l.floor })].filter(Boolean).join(" · ")}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onPick(null)}
          className={cn(
            "rounded-lg border border-dashed px-3 py-2 text-xs",
            selectedId === null ? "border-brand bg-brand-soft text-fg" : "border-line-strong text-fg-muted hover:bg-surface-muted",
          )}
        >
          + {t("form.newLocation")}
        </button>
      </div>
    </div>
  );
}

export function SalesColorDot({ color }: { color: string | null }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorOrFallback(color) }} aria-hidden />;
}
