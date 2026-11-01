import { apiRoute } from "@/server/http";
import { cancelExpense } from "@/server/services/expenses";

/** Cancels a pending expense recorded by mistake (the row is kept). */
export const DELETE = apiRoute(async ({ user, params }) => ({ expense: await cancelExpense(user, params.id!) }));
