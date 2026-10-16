import { z } from "zod";
import type { DiscoveryAdapter } from "./adapter.js";
import { JobBankAdapter, JobBankAdapterConfigSchema } from "./job-bank.js";
import { OverpassAdapter, OverpassAdapterConfigSchema } from "./overpass.js";

export const DiscoveryAdapterIdSchema = z.enum(["overpass", "job_bank"]);
export type DiscoveryAdapterId = z.infer<typeof DiscoveryAdapterIdSchema>;

export function parseDiscoveryAdapterConfig(
  adapterId: DiscoveryAdapterId,
  input: unknown,
): Record<string, unknown> {
  if (adapterId === "job_bank")
    return JobBankAdapterConfigSchema.parse(input ?? {});
  if (adapterId === "overpass")
    return OverpassAdapterConfigSchema.parse(input ?? {});
  return z.object({}).parse(input ?? {});
}

export function createDiscoveryAdapters(): Record<string, DiscoveryAdapter> {
  return {
    overpass: new OverpassAdapter(),
    job_bank: new JobBankAdapter(),
  };
}
