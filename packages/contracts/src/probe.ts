import { z } from "zod";

const Title = z.string().trim().min(1).max(200);
const Id = z.uuid();
const Version = z.int().positive();

export const ProbeDtoSchema = z.object({
  id: Id,
  title: z.string(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProbeDto = z.infer<typeof ProbeDtoSchema>;

export const StateRevisionDtoSchema = z.object({ stateRevision: z.int().nonnegative() });
export type StateRevisionDto = z.infer<typeof StateRevisionDtoSchema>;

export const CreateProbeInputSchema = z.strictObject({ title: Title });
export type CreateProbeInput = z.infer<typeof CreateProbeInputSchema>;

export const GetProbeInputSchema = z.strictObject({ id: Id });
export type GetProbeInput = z.infer<typeof GetProbeInputSchema>;

/** A write based on a previously read state must carry the version it saw (ARCHITECTURE §13). */
export const RenameProbeInputSchema = z.strictObject({
  id: Id,
  expectedVersion: Version,
  title: Title,
});
export type RenameProbeInput = z.infer<typeof RenameProbeInputSchema>;
