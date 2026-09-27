import { z } from "zod";

export const StateRevisionDtoSchema = z.object({ stateRevision: z.int().nonnegative() });
export type StateRevisionDto = z.infer<typeof StateRevisionDtoSchema>;
