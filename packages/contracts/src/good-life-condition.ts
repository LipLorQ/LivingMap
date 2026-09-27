import { z } from "zod";

const Id = z.uuid();
const Version = z.int().positive();
const Text = z.string().trim().min(1).max(300);

export const GoodLifeConditionDtoSchema = z.object({
  id: Id,
  text: z.string(),
  position: z.int().nonnegative(),
  version: Version,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GoodLifeConditionDto = z.infer<typeof GoodLifeConditionDtoSchema>;

export const AddGoodLifeConditionInputSchema = z.strictObject({ text: Text });
export type AddGoodLifeConditionInput = z.infer<typeof AddGoodLifeConditionInputSchema>;

export const EditGoodLifeConditionInputSchema = z.strictObject({ id: Id, expectedVersion: Version, text: Text });
export type EditGoodLifeConditionInput = z.infer<typeof EditGoodLifeConditionInputSchema>;

export const RemoveGoodLifeConditionInputSchema = z.strictObject({ id: Id, expectedVersion: Version });
export type RemoveGoodLifeConditionInput = z.infer<typeof RemoveGoodLifeConditionInputSchema>;

export const ReorderGoodLifeConditionsInputSchema = z.strictObject({ orderedIds: z.array(Id).min(1) });
export type ReorderGoodLifeConditionsInput = z.infer<typeof ReorderGoodLifeConditionsInputSchema>;
