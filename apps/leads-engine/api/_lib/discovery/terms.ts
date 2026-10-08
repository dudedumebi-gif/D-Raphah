/**
 * Third-party terms acceptance for discovery inputs (audit gap 2).
 *
 * The Overpass API usage policy and the OpenStreetMap ODbL attribution terms
 * are not the Lead Engine's own policy documents, so the source approval
 * gate (which evaluates collection-source policies) does not cover them.
 * This module is the narrowest coherent mechanism: a workspace-level
 * acceptance record, checked before any discovery run executes — manual
 * "Run now" or the scheduled daily run.
 *
 * Acceptance is recorded explicitly by an owner/administrator via
 * POST /api/v1/terms/accept. The check refuses with 409 and names the exact
 * remediation when no acceptance exists.
 */

export const OVERPASS_OSM_TERMS_ID = "overpass-osm";
/** Version of the terms summary the operator accepted (see runbook/docs). */
export const OVERPASS_OSM_TERMS_VERSION = "2026-09-26";

export const TORONTO_OPEN_DATA_TERMS_ID = "toronto-open-data";
export const TORONTO_OPEN_DATA_TERMS_VERSION = "ogl-toronto-1.0@2026-09-29";
export const JOB_BANK_OPEN_DATA_TERMS_ID = "canada-job-bank-open-data";
export const JOB_BANK_OPEN_DATA_TERMS_VERSION = "ogl-canada-2.0@2026-09-29";

export const DISCOVERY_TERMS = {
  overpass: {
    id: OVERPASS_OSM_TERMS_ID,
    version: OVERPASS_OSM_TERMS_VERSION,
    label: "Overpass API usage policy and OpenStreetMap ODbL attribution",
    summary:
      "Public Overpass instances impose usage limits, and OpenStreetMap data requires attribution under the ODbL.",
    reviewLinks: [
      {
        label: "Review Overpass API usage guidance",
        href: "https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances",
      },
      {
        label: "Review OpenStreetMap copyright and licence",
        href: "https://www.openstreetmap.org/copyright",
      },
    ],
  },
  toronto_open_data: {
    id: TORONTO_OPEN_DATA_TERMS_ID,
    version: TORONTO_OPEN_DATA_TERMS_VERSION,
    label: "Open Government Licence – Toronto",
    summary:
      "Review the City of Toronto licence, including attribution, permitted use, exemptions, and non-endorsement requirements.",
    reviewLinks: [
      {
        label: "Review Open Government Licence – Toronto",
        href: "https://open.toronto.ca/open-data-license/",
      },
    ],
  },
  job_bank: {
    id: JOB_BANK_OPEN_DATA_TERMS_ID,
    version: JOB_BANK_OPEN_DATA_TERMS_VERSION,
    label: "Open Government Licence – Canada (Job Bank open data)",
    summary:
      "Review the Government of Canada licence, including attribution, permitted use, exemptions, and non-endorsement requirements.",
    reviewLinks: [
      {
        label: "Review Open Government Licence – Canada",
        href: "https://open.canada.ca/en/open-government-licence-canada",
      },
    ],
  },
} as const;

export function termsForAdapter(adapterId: string) {
  const terms = DISCOVERY_TERMS[adapterId as keyof typeof DISCOVERY_TERMS];
  if (!terms)
    throw Object.assign(new Error(`No terms registry entry for ${adapterId}`), {
      statusCode: 422,
    });
  return terms;
}

/** Minimal shape for the check; implemented against the data client. */
export interface TermsLookup {
  hasAccepted(workspaceId: string, termsId: string): Promise<boolean>;
}

export class TermsNotAcceptedError extends Error {
  readonly statusCode = 409;
  constructor(
    workspaceId: string,
    termsId = OVERPASS_OSM_TERMS_ID,
    label = "Overpass/OSM terms",
  ) {
    super(
      `${label} not accepted for this workspace. ` +
        `Record acceptance with POST /api/v1/terms/accept ` +
        `{"termsId":"${termsId}"} before running discovery ` +
        `(workspace ${workspaceId}).`,
    );
    this.name = "TermsNotAcceptedError";
  }
}

export async function requireTermsAcceptance(
  lookup: TermsLookup,
  workspaceId: string,
  termsId: string = OVERPASS_OSM_TERMS_ID,
  label = "Overpass/OSM terms",
): Promise<void> {
  const accepted = await lookup.hasAccepted(workspaceId, termsId);
  if (!accepted) throw new TermsNotAcceptedError(workspaceId, termsId, label);
}
