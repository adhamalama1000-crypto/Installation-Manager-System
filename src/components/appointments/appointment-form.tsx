"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
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
import type { ProductCategory } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert, Badge, SalesTag } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api-client";
import { colorOrFallback } from "@/lib/colors";
import { DURATION_PRESETS, PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, minutesLabel } from "@/lib/constants";
import { timeRange } from "@/lib/format";
import { checkMapUrl, extractCoordinates } from "@/lib/maps";
import type { AppointmentDTO, ConflictDTO, StatusDTO } from "@/lib/types";
import type { FormValues } from "./form-values";
import { appointmentInputSchema, fieldErrorsFromZod } from "@/lib/validation";
import { cn } from "@/lib/utils";

type TechOption = { id: string; name: string; isActive: boolean };
type Availability = Record<string, { available: boolean; conflicts: ConflictDTO[] }>;
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
  const t = ((total % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`, nextDay };
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
}) {
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
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await api<{ technicians: { id: string; available: boolean; conflicts: ConflictDTO[] }[] }>("/api/appointments/availability", {
          method: "POST",
          body: { date: v.date, startTime: v.startTime, durationMinutes: v.durationMinutes, excludeAppointmentId: appointmentId ?? null },
          signal: ctrl.signal,
        });
        setAvailability(Object.fromEntries(res.technicians.map((t2) => [t2.id, { available: t2.available, conflicts: t2.conflicts }])));
      } catch (e) {
        if ((e as Error).name !== "AbortError") setAvailability(null);
      } finally {
        if (!ctrl.signal.aborted) setChecking(false);
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [v.date, v.startTime, v.durationMinutes, appointmentId]);

  const selectedStatus = statuses.find((st) => st.id === v.statusId);
  const statusBlocks = selectedStatus ? selectedStatus.blocksSchedule : true;
  const end = addMinutesToTime(v.startTime, v.durationMinutes);
  const busySelected = useMemo(
    () => (statusBlocks && availability ? v.technicianIds.filter((id) => availability[id] && !availability[id]!.available) : []),
    [availability, v.technicianIds, statusBlocks],
  );

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
      toast.error("Please correct the highlighted fields.");
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
      toast.success(mode === "create" ? `Appointment ${res.appointment.code} created` : `Appointment ${res.appointment.code} updated`);
      router.push(`/appointments/${res.appointment.id}`);
      router.refresh();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError("Unexpected error", 0, "UNKNOWN");
      if (apiErr.code === "SCHEDULING_CONFLICT") {
        setConflicts(apiErr.conflicts);
        toast.error("Scheduling conflict - your entries are kept. Choose another technician or time.");
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
  const activeTechs = technicians.filter((t) => t.isActive || v.technicianIds.includes(t.id));

  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-6">
        {formError && (
          <Alert tone="danger" title="Could not save">
            {formError}
            {formError.includes("someone else") && (
              <button type="button" className="ml-2 font-medium text-brand-text underline" onClick={() => window.location.reload()}>
                Reload
              </button>
            )}
          </Alert>
        )}

        <Card>
          <CardHeader title="Customer" description="Search to reuse an existing customer, or enter a new one." icon={<UserIcon className="h-4 w-4" />} />
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
              <p className="text-xs text-fg-subtle">Editing these fields updates the existing customer record.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div data-field="customer.name" className="sm:col-span-2">
                <Field label="Customer full name" required error={err("customer.name")}>
                  {(p) => <Input {...p} value={v.customer.name} onChange={(e) => setCustomer({ name: e.target.value })} autoComplete="off" />}
                </Field>
              </div>
              <div data-field="customer.phone">
                <Field label="Primary phone" required error={err("customer.phone")}>
                  {(p) => <Input {...p} type="tel" inputMode="tel" value={v.customer.phone} onChange={(e) => setCustomer({ phone: e.target.value })} placeholder="+20 100 000 0000" />}
                </Field>
              </div>
              <div data-field="customer.secondaryPhone">
                <Field label="Secondary phone" error={err("customer.secondaryPhone")} hint="Optional">
                  {(p) => <Input {...p} type="tel" inputMode="tel" value={v.customer.secondaryPhone} onChange={(e) => setCustomer({ secondaryPhone: e.target.value })} />}
                </Field>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Installation location" description="Entered by Sales. Shown to the assigned technicians." icon={<MapPin className="h-4 w-4" />} />
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div data-field="location.streetAddress" className="sm:col-span-2">
                <Field label="Full written address" error={err("location.streetAddress")} hint="Street, number, landmarks">
                  {(p) => <Input {...p} value={v.location.streetAddress} onChange={(e) => setLocation({ streetAddress: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.area">
                <Field label="Area / neighbourhood" error={err("location.area")}>
                  {(p) => <Input {...p} value={v.location.area} onChange={(e) => setLocation({ area: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.building">
                <Field label="Compound / building" error={err("location.building")}>
                  {(p) => <Input {...p} value={v.location.building} onChange={(e) => setLocation({ building: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.apartment">
                <Field label="Apartment / unit number" error={err("location.apartment")}>
                  {(p) => <Input {...p} value={v.location.apartment} onChange={(e) => setLocation({ apartment: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.floor">
                <Field label="Floor number" error={err("location.floor")}>
                  {(p) => <Input {...p} value={v.location.floor} onChange={(e) => setLocation({ floor: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.accessInstructions" className="sm:col-span-2">
                <Field label="Access instructions" error={err("location.accessInstructions")} hint="Optional - gate, parking, who to call on arrival">
                  {(p) => <Textarea {...p} rows={2} value={v.location.accessInstructions} onChange={(e) => setLocation({ accessInstructions: e.target.value })} />}
                </Field>
              </div>
              <div data-field="location.mapUrl" className="sm:col-span-2">
                <Field
                  label="Map link"
                  error={err("location.mapUrl")}
                  hint={
                    mapCheck && mapCheck.ok && !mapCheck.knownHost
                      ? `Link to ${mapCheck.host} - not a recognised maps site, double-check it.`
                      : "Paste a Google Maps (or other maps app) link. It is saved exactly as entered."
                  }
                >
                  {(p) => (
                    <div className="flex gap-2">
                      <Input {...p} type="url" inputMode="url" value={v.location.mapUrl} onChange={(e) => setLocation({ mapUrl: e.target.value })} placeholder="https://maps.app.goo.gl/..." />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-10 w-10"
                        title="Test link"
                        disabled={!mapCheck?.ok}
                        onClick={() => mapCheck?.ok && window.open(mapCheck.url, "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="sr-only">Test link</span>
                      </Button>
                    </div>
                  )}
                </Field>
              </div>
              <div data-field="location.latitude">
                <Field label="Latitude" error={err("location.latitude")} hint="Optional">
                  {(p) => <Input {...p} inputMode="decimal" value={v.location.latitude} onChange={(e) => setLocation({ latitude: e.target.value })} placeholder="30.0444" />}
                </Field>
              </div>
              <div data-field="location.longitude">
                <Field label="Longitude" error={err("location.longitude")} hint="Optional">
                  {(p) => <Input {...p} inputMode="decimal" value={v.location.longitude} onChange={(e) => setLocation({ longitude: e.target.value })} placeholder="31.2357" />}
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
                    toast.success("Coordinates filled in from the link.");
                  } else {
                    toast.info("This link does not contain coordinates (short links can't be read). The link itself is enough.");
                  }
                }}
              >
                <Crosshair className="h-4 w-4" /> Fill coordinates from link
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Installation & product" icon={<Package className="h-4 w-4" />} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <div data-field="productCategory">
              <Field label="Product category" required error={err("productCategory")}>
                {(p) => (
                  <Select {...p} value={v.productCategory} onChange={(e) => set("productCategory", e.target.value as ProductCategory)}>
                    <option value="">Choose…</option>
                    {PRODUCT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {PRODUCT_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {v.productCategory === "OTHER" ? (
              <div data-field="categoryOther">
                <Field label="Describe the category" required error={err("categoryOther")}>
                  {(p) => <Input {...p} value={v.categoryOther} onChange={(e) => set("categoryOther", e.target.value)} />}
                </Field>
              </div>
            ) : (
              <div className="hidden sm:block" />
            )}
            <div data-field="brand">
              <Field label="Brand" error={err("brand")}>
                {(p) => <Input {...p} value={v.brand} onChange={(e) => set("brand", e.target.value)} />}
              </Field>
            </div>
            <div data-field="model">
              <Field label="Model" error={err("model")}>
                {(p) => <Input {...p} value={v.model} onChange={(e) => set("model", e.target.value)} />}
              </Field>
            </div>
            <div data-field="description" className="sm:col-span-2">
              <Field label="Installation description" error={err("description")}>
                {(p) => <Textarea {...p} rows={3} value={v.description} onChange={(e) => set("description", e.target.value)} />}
              </Field>
            </div>
            <div data-field="requiredEquipment" className="sm:col-span-2">
              <Field label="Required equipment / accessories" error={err("requiredEquipment")}>
                {(p) => <Textarea {...p} rows={2} value={v.requiredEquipment} onChange={(e) => set("requiredEquipment", e.target.value)} />}
              </Field>
            </div>
            <div data-field="additionalNotes" className="sm:col-span-2">
              <Field label="Additional installation notes" error={err("additionalNotes")} hint="Visible to the assigned technicians">
                {(p) => <Textarea {...p} rows={2} value={v.additionalNotes} onChange={(e) => set("additionalNotes", e.target.value)} />}
              </Field>
            </div>
            {canSeeInternalNotes && (
              <div data-field="internalNotes" className="sm:col-span-2">
                <Field label="Internal company notes" error={err("internalNotes")} hint="Not shown to technicians or to viewers without permission">
                  {(p) => <Textarea {...p} rows={2} value={v.internalNotes} onChange={(e) => set("internalNotes", e.target.value)} />}
                </Field>
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="space-y-6 xl:sticky xl:top-20 xl:self-start">
        <Card id="schedule" className="scroll-mt-20">
          <CardHeader title="Schedule" description={`Times are in ${tz}`} icon={<CalendarClock className="h-4 w-4" />} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <div data-field="date">
              <Field label="Date" required error={err("date")}>
                {(p) => <Input {...p} type="date" value={v.date} onChange={(e) => set("date", e.target.value)} />}
              </Field>
            </div>
            <div data-field="startTime">
              <Field label="Start time" required error={err("startTime")}>
                {(p) => <Input {...p} type="time" step={300} value={v.startTime} onChange={(e) => set("startTime", e.target.value)} />}
              </Field>
            </div>
            <div data-field="durationMinutes">
              <Field label="Expected duration" required error={err("durationMinutes")}>
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
                        {minutesLabel(d)}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </Select>
                )}
              </Field>
            </div>
            {customDuration ? (
              <div>
                <Field label="Minutes" required>
                  {(p) => (
                    <Input {...p} type="number" min={15} max={1440} step={15} value={v.durationMinutes || ""} onChange={(e) => set("durationMinutes", Number(e.target.value))} />
                  )}
                </Field>
              </div>
            ) : (
              <div className="flex flex-col justify-end">
                <p className="text-xs font-medium text-fg-muted">Ends at</p>
                <p className="mt-1 flex h-10 items-center rounded-lg bg-surface-muted px-3 text-sm font-semibold tabular-nums">
                  {end.time}
                  {end.nextDay > 0 && <span className="ml-1 text-xs font-normal text-warning">(+{end.nextDay} day)</span>}
                </p>
              </div>
            )}
            {customDuration && (
              <p className="text-sm text-fg-muted sm:col-span-2">
                Ends at <span className="font-semibold tabular-nums text-fg">{end.time}</span>
                {end.nextDay > 0 && <span className="text-warning"> (next day)</span>}
              </p>
            )}
            <div data-field="statusId" className="sm:col-span-2">
              <Field label="Status" error={err("statusId")}>
                {(p) => (
                  <Select {...p} value={v.statusId} onChange={(e) => set("statusId", e.target.value)}>
                    {statuses
                      .filter((st) => st.isActive || st.id === initial.statusId)
                      .map((st) => (
                        <option key={st.id} value={st.id}>
                          {st.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>
            {mode === "create" && salesOptions ? (
              <div data-field="salesUserId" className="sm:col-span-2">
                <Field label="Sales employee (original creator)" error={err("salesUserId")} hint="Determines the appointment colour. Cannot be changed later.">
                  {(p) => (
                    <Select {...p} value={v.salesUserId} onChange={(e) => set("salesUserId", e.target.value)}>
                      {salesOptions.map((so) => (
                        <option key={so.id} value={so.id}>
                          {so.name}
                          {so.id === currentUserId ? " (me)" : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            ) : originalCreator ? (
              <div className="sm:col-span-2">
                <p className="text-xs font-medium text-fg-muted">Original Sales creator</p>
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
            title="Technicians"
            description={checking ? "Checking availability…" : statusBlocks ? "Availability for the selected time" : "This status does not block schedules"}
            icon={checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
          />
          <div className="space-y-3 p-5" data-field="technicianIds">
            {conflicts.length > 0 && (
              <Alert tone="danger" title="Scheduling conflict">
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {conflicts.map((c) => (
                    <li key={`${c.technicianId}-${c.appointmentId}`}>
                      <strong className="text-fg">{c.technicianName}</strong> is already booked {timeRange(c.startsAt, c.endsAt, tz)} ({c.appointmentCode}
                      {c.customerName ? `, ${c.customerName}` : ""}).
                    </li>
                  ))}
                </ul>
                <p className="mt-2">Choose another technician or change the time. Your other entries are kept.</p>
              </Alert>
            )}
            {busySelected.length > 0 && conflicts.length === 0 && (
              <Alert tone="warning">
                {busySelected.map((id) => technicians.find((t) => t.id === id)?.name).join(", ")} {busySelected.length === 1 ? "is" : "are"} busy at this time.
              </Alert>
            )}
            {err("technicianIds") && <Alert tone="danger">{err("technicianIds")}</Alert>}
            {activeTechs.length === 0 && <p className="text-sm text-fg-muted">No active technicians. An Admin can add technicians under Users.</p>}
            <ul className="space-y-2">
              {activeTechs.map((t) => {
                const a = availability?.[t.id];
                const selected = v.technicianIds.includes(t.id);
                const busy = statusBlocks && a && !a.available;
                const conflicted = conflicts.some((c) => c.technicianId === t.id);
                return (
                  <li key={t.id}>
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
                        disabled={(busy && !selected) || (!t.isActive && !selected)}
                        onChange={() => toggleTech(t.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-fg">{t.name}</span>
                          {!t.isActive && <Badge>inactive</Badge>}
                          {a &&
                            (busy ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                                <XCircle className="h-3.5 w-3.5" /> Busy
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Available
                              </span>
                            ))}
                        </span>
                        {busy &&
                          a!.conflicts.map((c) => (
                            <span key={c.appointmentId} className="mt-0.5 block text-xs text-fg-muted">
                              {timeRange(c.startsAt, c.endsAt, tz)} · {c.appointmentCode}
                              {c.customerName ? ` · ${c.customerName}` : ""}
                            </span>
                          ))}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {v.technicianIds.length === 0 && <p className="text-xs text-fg-subtle">You can save without a technician; it will be flagged as needing attention.</p>}
          </div>
        </Card>
        </div>

        <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-surface/95 p-4 backdrop-blur sm:mx-0 sm:rounded-xl sm:border xl:static xl:border-0 xl:bg-transparent xl:p-0">
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => router.back()} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" className="flex-[2]" loading={saving}>
              {mode === "create" ? "Create appointment" : "Save changes"}
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
    const t = setTimeout(async () => {
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
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => results.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="Find existing customer by name or phone"
            aria-label="Find existing customer"
            className="pl-9"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-fg-subtle" />}
        </div>
        {selectedId && (
          <Button type="button" variant="outline" onClick={onClear} title="Enter a new customer instead">
            <UserPlus className="h-4 w-4" /> <span className="hidden sm:inline">New customer</span>
          </Button>
        )}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-pop">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(c);
                  setOpen(false);
                  setQ("");
                }}
              >
                <span className="text-sm font-medium text-fg">{c.name}</span>
                <span className="text-xs text-fg-muted">
                  {c.phone}
                  {c.locations[0] ? ` · ${[c.locations[0].building, c.locations[0].area].filter(Boolean).join(", ")}` : ""}
                  {c.locations.length > 1 ? ` · ${c.locations.length} locations` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !loading && q.trim().length >= 2 && results.length === 0 && (
        <p className="mt-1 text-xs text-fg-subtle">No existing customer found - fill in the details below to add a new one.</p>
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
  if (!locations.length) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-fg-muted">Saved locations for this customer</p>
      <div className="flex flex-wrap gap-2">
        {locations.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onPick(l)}
            className={cn(
              "rounded-lg border px-3 py-2 text-left text-xs",
              selectedId === l.id ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted",
            )}
          >
            <span className="block font-medium text-fg">{[l.building, l.area].filter(Boolean).join(", ") || "Location"}</span>
            {[l.apartment && `Apt ${l.apartment}`, l.floor && `Floor ${l.floor}`].filter(Boolean).join(" · ")}
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
          + New location
        </button>
      </div>
    </div>
  );
}

export function SalesColorDot({ color }: { color: string | null }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorOrFallback(color) }} aria-hidden />;
}
