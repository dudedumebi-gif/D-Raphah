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

/** Minimal shape for the check; implemented against the data client. */
export interface TermsLookup {
  hasAccepted(workspaceId: string, termsId: string): Promise<boolean>;
}

export class TermsNotAcceptedError extends Error {
  readonly statusCode = 409;
  constructor(workspaceId: string) {
    super(
      `Overpass/OSM terms not accepted for this workspace. ` +
        `Record acceptance with POST /api/v1/terms/accept ` +
        `{"termsId":"${OVERPASS_OSM_TERMS_ID}"} before running discovery ` +
        `(workspace ${workspaceId}).`,
    );
    this.name = "TermsNotAcceptedError";
  }
}

export async function requireTermsAcceptance(
  lookup: TermsLookup,
  workspaceId: string,
  termsId: string = OVERPASS_OSM_TERMS_ID,
): Promise<void> {
  const accepted = await lookup.hasAccepted(workspaceId, termsId);
  if (!accepted) throw new TermsNotAcceptedError(workspaceId);
}
