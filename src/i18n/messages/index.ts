/**
 * All UI messages. Each domain file declares English and Arabic side by side; this index merges
 * them into one flat, typed dictionary. `MessageKey` is the union of every key, so `t("…")` with an
 * unknown key does not compile.
 */
import { admin } from "./admin";
import { appointments } from "./appointments";
import { calendar } from "./calendar";
import { common } from "./common";
import { enums } from "./enums";
import { errors } from "./errors";
import { ops } from "./ops";
import { pages } from "./pages";
import { server } from "./server";
import { shell } from "./shell";
import { validation } from "./validation";

export const messages = {
  ...admin,
  ...appointments,
  ...calendar,
  ...common,
  ...enums,
  ...errors,
  ...ops,
  ...pages,
  ...server,
  ...shell,
  ...validation,
};

export type MessageKey = keyof typeof messages;
