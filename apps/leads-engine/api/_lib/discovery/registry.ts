import { z } from "zod";
import type { DiscoveryAdapter } from "./adapter.js";
import { JobBankAdapter, JobBankAdapterConfigSchema } from "./job-bank.js";
import { OverpassAdapter } from "./overpass.js";
import {
  TorontoAdapterConfigSchema,
  TorontoOpenDataAdapter,
} from "./toronto-open-data.js";

export const DiscoveryAdapterIdSchema = z.enum([
  "overpass",
  "toronto_open_data",
  "job_bank",
]);
export type DiscoveryAdapterId = z.infer<typeof DiscoveryAdapterIdSchema>;

export function parseDiscoveryAdapterConfig(
  adapterId: DiscoveryAdapterId,
  input: unknown,
): Record<string, unknown> {
  if (adapterId === "toronto_open_data")
    return TorontoAdapterConfigSchema.parse(input ?? {});
  if (adapterId === "job_bank")
    return JobBankAdapterConfigSchema.parse(input ?? {});
  return z.object({}).parse(input ?? {});
}

export function createDiscoveryAdapters(): Record<string, DiscoveryAdapter> {
  return {
    overpass: new OverpassAdapter(),
    toronto_open_data: new TorontoOpenDataAdapter(),
    job_bank: new JobBankAdapter(),
  };
}
