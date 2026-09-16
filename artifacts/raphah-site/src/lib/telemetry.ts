import { supabase } from './supabase';

const sessionKey = 'raphah-observability-session';
const sessionId = (() => {
  try {
    const existing = sessionStorage.getItem(sessionKey);
    if (existing) return existing;
    const next = crypto.randomUUID();
    sessionStorage.setItem(sessionKey, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
})();
const queued: Array<Record<string, unknown>> = [];
let flushTimer: number | undefined;

async function flush() {
  if (!queued.length) return;
  const batch = queued.splice(0, 20);
  const { error } = await supabase.from('telemetry_events').insert(batch);
  if (error && batch.length && queued.length < 100) queued.unshift(...batch);
}

export async function track(eventName: string, eventData: Record<string, unknown> = {}) {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(eventName)) return;
  const safeData = Object.fromEntries(Object.entries(eventData).filter(([key, value]) => key.length <= 50 && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 20));
  const payload = {
    session_id: sessionId,
    event_name: eventName,
    route: window.location.pathname,
    event_data: safeData,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    user_agent: navigator.userAgent.slice(0, 500),
    referrer: document.referrer.slice(0, 500),
  };
  queued.push(payload);
  if (!flushTimer) flushTimer = window.setTimeout(() => { flushTimer = undefined; void flush(); }, 250);
  if (queued.length >= 20) void flush();
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
  try {
    const paintObserver = new PerformanceObserver((list) => {
      const entry = list.getEntries().find((item) => item.name === 'first-contentful-paint');
      if (entry && !seen.has('fcp')) { seen.add('fcp'); void track('fcp', { value: entry.startTime }); }
    });
    paintObserver.observe({ type: 'paint', buffered: true });
  } catch { /* Browser may not support paint timing. */ }
  return () => undefined;
}
