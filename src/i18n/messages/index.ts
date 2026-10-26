/**
 * All UI messages. Each domain file declares English and Arabic side by side; this index merges
 * them into one flat, typed dictionary. `MessageKey` is the union of every key, so `t("…")` with an
 * unknown key does not compile.
 */
import { common } from "./common";
import { enums } from "./enums";
import { errors } from "./errors";
import { shell } from "./shell";
import { validation } from "./validation";

export const messages = {
  ...common,
  ...enums,
  ...errors,
  ...shell,
  ...validation,
};

export type MessageKey = keyof typeof messages;
