// TEMPORARY: replace with @sidekik/contracts (see ./README.md). Only the type the gateway consumes.
import { z } from 'zod';

export const WorkMapPublishedSchema = z.object({
  workmap_id: z.string().min(1),
  workflow_id: z.string().min(1),
  version: z.number().int().positive(),
});
export type WorkMapPublished = z.infer<typeof WorkMapPublishedSchema>;
