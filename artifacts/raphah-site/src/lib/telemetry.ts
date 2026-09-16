import { supabase } from './supabase';

const sessionKey = 'raphah-observability-session';
const sessionId = (() => {
  const existing = sessionStorage.getItem(sessionKey);
  if (existing) return existing;
  const next = crypto.randomUUID();
  sessionStorage.setItem(sessionKey, next);
  return next;
})();

export async function track(eventName: string, eventData: Record<string, unknown> = {}) {
  const payload = {
    session_id: sessionId,
    event_name: eventName,
    route: window.location.pathname,
    event_data: eventData,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    user_agent: navigator.userAgent.slice(0, 500),
    referrer: document.referrer.slice(0, 500),
  };
  const { error } = await supabase.from('telemetry_events').insert(payload);
  if (error && import.meta.env.DEV) console.warn('[v0] telemetry insert failed', error.message);
}

export function startTelemetry() {
  void track('page_view', { title: document.title });
  window.addEventListener('error', () => void track('error', { source: 'window' }));
  window.addEventListener('unhandledrejection', () => void track('error', { source: 'promise' }));
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav) void track('timing', { ttfb: nav.responseStart, dom_content_loaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd });
  const seen = new Set<string>();
  for (const type of ['largest-contentful-paint', 'layout-shift', 'first-input'] as const) {
    try {
      const observer = new PerformanceObserver((list) => {
        const entry = list.getEntries().at(-1) as PerformanceEntry & { value?: number; startTime: number; processingStart?: number };
        if (!entry || seen.has(type)) return;
        seen.add(type);
        const value = type === 'layout-shift' ? entry.value ?? 0 : type === 'first-input' ? (entry.processingStart ?? 0) - entry.startTime : entry.startTime;
        void track(type === 'first-input' ? 'inp' : type === 'layout-shift' ? 'cls' : 'lcp', { value });
      });
      observer.observe({ type, buffered: true } as PerformanceObserverInit);
    } catch { /* Browser may not support this observer. */ }
  }
  return () => undefined;
}
