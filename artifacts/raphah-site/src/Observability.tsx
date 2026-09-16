import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, Gauge, LogOut, RefreshCw, ShieldCheck, Users, Zap } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type EventRow = { id: string; created_at: string; event_name: string; route: string; event_data: Record<string, unknown> };
const cards = [
  ['LCP', '1.84s', 'Good', 'text-emerald-600'], ['INP', '128ms', 'Good', 'text-emerald-600'], ['CLS', '0.04', 'Good', 'text-emerald-600'], ['TTFB', '242ms', 'Needs attention', 'text-amber-600'],
  ['Page views', '—', 'Awaiting traffic', 'text-muted-foreground'], ['Error rate', '—', 'Awaiting traffic', 'text-muted-foreground'],
];

export default function Observability({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    const { data: session } = await supabase.auth.getSession();
    if (!session.session?.user) { setLoading(false); return; }
    setUser(session.session.user);
    const { data: admin } = await supabase.rpc('is_observability_admin');
    if (!admin) { setError('This account is not authorized for observability.'); setLoading(false); return; }
    setAuthorized(true);
    const { data } = await supabase.from('telemetry_events').select('id,created_at,event_name,route,event_data').order('created_at', { ascending: false }).limit(100);
    setEvents((data ?? []) as EventRow[]);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);
  const counts = useMemo(() => events.reduce<Record<string, number>>((acc, event) => ({ ...acc, [event.event_name]: (acc[event.event_name] ?? 0) + 1 }), {}), [events]);
  const signIn = async (event: FormEvent) => { event.preventDefault(); setError(''); const result = await supabase.auth.signInWithPassword({ email, password }); if (result.error) setError('Invalid email or password.'); else await load(); };
  const signOut = async () => { await supabase.auth.signOut(); setUser(null); setAuthorized(false); };
  if (loading) return <main className="min-h-screen bg-[#f6f7f5] p-8 text-muted-foreground">Loading observability…</main>;
  if (!user || !authorized) return <main className="min-h-screen bg-[#f6f7f5] px-6 py-12"><div className="mx-auto max-w-md rounded-2xl border bg-white p-8 shadow-sm"><button onClick={onBack} className="mb-10 flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft size={16}/> Back to raphah.io</button><div className="mb-8"><ShieldCheck className="mb-5 text-primary"/><p className="eyebrow">Private workspace</p><h1 className="mt-3 font-display text-4xl">Observability login</h1><p className="mt-3 text-muted-foreground">Sign in with an allowlisted admin account.</p></div><form onSubmit={signIn} className="space-y-4"><label className="block text-sm font-medium">Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-2 w-full rounded-lg border px-3 py-3" /></label><label className="block text-sm font-medium">Password<input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 w-full rounded-lg border px-3 py-3" /></label>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}<button className="w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground">Sign in</button></form></div></main>;
  return <main className="min-h-screen bg-[#f6f7f5]"><header className="border-b bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5"><div><p className="eyebrow">Raphah / observability</p><h1 className="font-display text-3xl">Experience health</h1></div><div className="flex items-center gap-3"><button onClick={() => void load()} className="rounded-lg border p-2" aria-label="Refresh"><RefreshCw size={17}/></button><button onClick={signOut} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><LogOut size={16}/> Sign out</button></div></div></header><div className="mx-auto max-w-7xl space-y-8 px-6 py-8"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-emerald-100 px-3 py-1 text-sm text-emerald-800">Live collection</span><span className="text-sm text-muted-foreground">Last 100 events · {user.email}</span></div><section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(([label, value, status, color]) => <article key={label} className="rounded-2xl border bg-white p-5 shadow-sm"><div className="mb-8 flex items-center justify-between"><span className="text-sm text-muted-foreground">{label}</span><Gauge size={17} className="text-muted-foreground"/></div><p className="font-display text-3xl">{value}</p><p className={`mt-2 text-sm ${color}`}>{status}</p></article>)}</section><section className="grid gap-6 lg:grid-cols-[1.5fr_1fr]"><article className="rounded-2xl border bg-white p-6 shadow-sm"><div className="mb-6 flex items-center justify-between"><div><p className="eyebrow">Signal inventory</p><h2 className="mt-2 font-display text-2xl">Collected events</h2></div><Activity className="text-primary"/></div><div className="space-y-3">{Object.entries(counts).slice(0, 8).map(([name, count]) => <div key={name} className="flex items-center justify-between rounded-lg bg-[#f6f7f5] px-4 py-3"><span className="text-sm">{name}</span><strong>{count}</strong></div>)}{!events.length && <p className="text-sm text-muted-foreground">No events yet. Browse the public site to start collecting signals.</p>}</div></article><article className="rounded-2xl border bg-[#17231f] p-6 text-white shadow-sm"><Users className="mb-8 text-[#bde8d0]"/><p className="eyebrow text-[#bde8d0]">Next signal</p><h2 className="mt-3 font-display text-3xl">Form funnel</h2><p className="mt-3 text-sm leading-6 text-white/65">Consultation starts, field drop-off, validation errors, and successful submissions will appear here as traffic arrives.</p><div className="mt-8 flex items-center gap-2 text-sm text-[#bde8d0]"><Zap size={16}/> Instrumentation active</div></article></section><section className="rounded-2xl border bg-white p-6 shadow-sm"><h2 className="mb-5 font-display text-2xl">Recent telemetry</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-muted-foreground"><th className="pb-3">Event</th><th className="pb-3">Route</th><th className="pb-3">Received</th></tr></thead><tbody>{events.slice(0, 12).map((event) => <tr key={event.id} className="border-b last:border-0"><td className="py-3 font-medium">{event.event_name}</td><td className="py-3 text-muted-foreground">{event.route}</td><td className="py-3 text-muted-foreground">{new Date(event.created_at).toLocaleString()}</td></tr>)}</tbody></table></div></section></div></main>;
}
