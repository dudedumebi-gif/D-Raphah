/**
 * Delivery Factory environment scope (Phase 0 separation). The dashboard
 * always operates in exactly one environment: 'demo' holds the pilot's
 * sample portfolio data and demo-scoped workflows; 'production' holds live
 * client work. The backend enforces the same scope on every record, so
 * this selection is a view onto separated data — not a cosmetic filter.
 */
export type DeliveryEnvironment = "demo" | "production";
