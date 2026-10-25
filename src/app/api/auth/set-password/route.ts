import { fieldErrorsFromZod, setPasswordSchema } from "@/lib/validation";
import { ValidationError } from "@/server/errors";
import { publicRoute, readJson } from "@/server/http";
import { setPasswordWithToken } from "@/server/services/users";

export const POST = publicRoute(async ({ req }) => {
  const parsed = setPasswordSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  await setPasswordWithToken(parsed.data.token, parsed.data.password);
  return { ok: true };
});
