import type { CustodyStatus, CustomerConfirmation, LeaveStatus, LeaveType, PaymentMethod, ProductCategory, Role, StatusKind, VisitType } from "@prisma/client";

export type StatusDTO = {
  id: string;
  /** Name as configured (English or the company's own wording). */
  name: string;
  /** Arabic name; Arabic readers see it when set. */
  nameAr: string | null;
  /** The name in the reader's language. */
  label: string;
  kind: StatusKind;
  color: string;
  blocksSchedule: boolean;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
};

export type UserRef = { id: string; name: string; color: string | null; isActive: boolean };

export type LocationDTO = {
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
  /** Link used by "Open Location" (saved URL, or built from coordinates), null when missing. */
  link: string | null;
};

export type AppointmentDTO = {
  id: string;
  number: number;
  code: string;
  productCategory: ProductCategory;
  categoryOther: string | null;
  visitType: VisitType | null;
  customerConfirmation: CustomerConfirmation;
  /** The visit this one follows up, and later visits that follow up this one (only those the viewer may see). */
  followUpOf: { id: string; code: string } | null;
  followUps: { id: string; code: string; startsAt: string; status: { name: string; color: string; kind: StatusKind } }[];
  brand: string | null;
  model: string | null;
  description: string | null;
  requiredEquipment: string | null;
  additionalNotes: string | null;
  /** Undefined when the viewer may not see internal notes. */
  internalNotes?: string | null;
  visitReport: string | null;
  reportedAt: string | null;
  reportedBy: { id: string; name: string } | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: Pick<StatusDTO, "id" | "name" | "kind" | "color" | "blocksSchedule">;
  createdBy: UserRef;
  updatedBy: { id: string; name: string } | null;
  technicians: UserRef[];
  customer: {
    id: string;
    name: string;
    /** Undefined when the viewer may not see contact details. */
    phone?: string;
    secondaryPhone?: string | null;
  };
  /** Null when the viewer may not see the installation address. */
  location: LocationDTO | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Whether the current user may edit / reschedule / cancel / change status. */
  canManage: boolean;
  /** Whether the current user may record the outcome of the visit (assigned technician or manager). */
  canReport: boolean;
  /** Money for this visit; null for roles that may not see it. */
  payment: PaymentDTO | null;
  /** Serial-numbered items installed at this visit, each with its warranty end date. */
  installed: { serial: string; model: string; warrantyUntil: string | null }[];
  /** Ticked delivery checklist items (see lib/delivery). */
  deliveryChecklist: string[];
};

/**
 * Prices are shown to people who manage bookings or the finances. Technicians only get what to
 * collect (`due`) and what they recorded; the price fields are then left out.
 */
export type PaymentDTO = {
  totalPrice?: number | null;
  depositAmount?: number | null;
  depositMethod?: PaymentMethod | null;
  extraFee?: number | null;
  /** Price minus deposit plus extra fee; null when no price or fee is recorded. */
  due: number | null;
  collectedAmount: number | null;
  collectedMethod: PaymentMethod | null;
  collectedAt: string | null;
  collectedBy: { id: string; name: string } | null;
  /** Still owed after the collection (due minus collected). */
  balance: number | null;
  custody?: { status: CustodyStatus; holder: { id: string; name: string }; receivedAt: string | null; receivedBy: { id: string; name: string } | null } | null;
};

export type AppointmentListItem = {
  id: string;
  code: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  customerName: string;
  customerPhone?: string;
  area?: string | null;
  building?: string | null;
  productCategory: ProductCategory;
  categoryOther: string | null;
  visitType: VisitType | null;
  customerConfirmation: CustomerConfirmation;
  brand: string | null;
  model: string | null;
  status: Pick<StatusDTO, "id" | "name" | "kind" | "color">;
  createdBy: UserRef;
  technicians: { id: string; name: string }[];
  hasLocation?: boolean;
};

export type AuditEntryDTO = {
  id: string;
  action: string;
  summary: string;
  changes: Record<string, { from: unknown; to: unknown }> | Record<string, unknown> | null;
  actor: { id: string; name: string } | null;
  createdAt: string;
  entityType: string;
  entityId: string;
  appointmentId: string | null;
};

export type UserDTO = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  color: string | null;
  viewerPermissions: string[];
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConflictDTO = {
  technicianId: string;
  technicianName: string;
  appointmentId: string;
  appointmentCode: string;
  startsAt: string;
  endsAt: string;
  customerName?: string;
};

export type ApiErrorBody = {
  error: { code: string; message: string; fieldErrors?: Record<string, string>; conflicts?: ConflictDTO[] };
};

export type LeaveDTO = {
  id: string;
  user: { id: string; name: string };
  startDate: string;
  endDate: string;
  days: number;
  type: LeaveType;
  reason: string | null;
  status: LeaveStatus;
  requestedBy: { id: string; name: string };
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  canCancel: boolean;
  canDecide: boolean;
};

/** A booking that falls inside a leave and needs another technician. */
export type LeaveClash = {
  appointmentId: string;
  code: string;
  customerName: string;
  startsAt: string;
  createdById: string;
};

/** A file attached to a visit, as shown in the browser (the bytes come from /api/attachments/[id]). */
export type AttachmentDTO = {
  id: string;
  kind: "BEFORE_PHOTO" | "AFTER_PHOTO" | "SIGNATURE" | "PAYMENT_PROOF" | "DEPOSIT_PROOF";
  url: string;
  uploadedBy: { id: string; name: string };
  createdAt: string;
  /** The reader may remove it (their own upload, or a manager of the booking). */
  canDelete: boolean;
};

/** Which kinds the reader may add to a visit. */
export type AttachmentRights = Record<AttachmentDTO["kind"], boolean>;
