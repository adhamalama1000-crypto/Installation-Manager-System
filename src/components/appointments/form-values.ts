import type { ProductCategory } from "@prisma/client";
import type { AppointmentDTO } from "@/lib/types";
import { dateKey, timeKey } from "@/lib/time";

export type FormValues = {
  customer: { id: string | null; name: string; phone: string; secondaryPhone: string };
  location: {
    id: string | null;
    area: string;
    streetAddress: string;
    building: string;
    apartment: string;
    floor: string;
    accessInstructions: string;
    mapUrl: string;
    latitude: string;
    longitude: string;
  };
  productCategory: ProductCategory | "";
  categoryOther: string;
  brand: string;
  model: string;
  description: string;
  requiredEquipment: string;
  additionalNotes: string;
  internalNotes: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  technicianIds: string[];
  statusId: string;
  salesUserId: string;
};

const s = (v: string | null | undefined) => v ?? "";

export function valuesFromAppointment(a: AppointmentDTO, tz: string): FormValues {
  return {
    customer: { id: a.customer.id, name: a.customer.name, phone: s(a.customer.phone), secondaryPhone: s(a.customer.secondaryPhone) },
    location: {
      id: a.location?.id ?? null,
      area: s(a.location?.area),
      streetAddress: s(a.location?.streetAddress),
      building: s(a.location?.building),
      apartment: s(a.location?.apartment),
      floor: s(a.location?.floor),
      accessInstructions: s(a.location?.accessInstructions),
      mapUrl: s(a.location?.mapUrl),
      latitude: a.location?.latitude != null ? String(a.location.latitude) : "",
      longitude: a.location?.longitude != null ? String(a.location.longitude) : "",
    },
    productCategory: a.productCategory,
    categoryOther: s(a.categoryOther),
    brand: s(a.brand),
    model: s(a.model),
    description: s(a.description),
    requiredEquipment: s(a.requiredEquipment),
    additionalNotes: s(a.additionalNotes),
    internalNotes: s(a.internalNotes),
    date: dateKey(a.startsAt, tz),
    startTime: timeKey(a.startsAt, tz),
    durationMinutes: a.durationMinutes,
    technicianIds: a.technicians.map((t) => t.id),
    statusId: a.status.id,
    salesUserId: a.createdBy.id,
  };
}


export function emptyValues(opts: { date: string; durationMinutes: number; statusId: string; salesUserId: string }): FormValues {
  return {
    customer: { id: null, name: "", phone: "", secondaryPhone: "" },
    location: { id: null, area: "", streetAddress: "", building: "", apartment: "", floor: "", accessInstructions: "", mapUrl: "", latitude: "", longitude: "" },
    productCategory: "",
    categoryOther: "",
    brand: "",
    model: "",
    description: "",
    requiredEquipment: "",
    additionalNotes: "",
    internalNotes: "",
    date: opts.date,
    startTime: "10:00",
    durationMinutes: opts.durationMinutes,
    technicianIds: [],
    statusId: opts.statusId,
    salesUserId: opts.salesUserId,
  };
}
