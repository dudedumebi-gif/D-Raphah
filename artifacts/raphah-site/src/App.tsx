import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Check, ChevronRight, Menu, ScanLine, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreateConsultation, type ConsultationInputTiming } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

const industries = [
  { name: 'Professional services', short: 'Professional services', copy: 'Make the handoffs between expertise, delivery, and billing easier to see — and easier to improve.', detail: 'Matter intake · delivery operations · capacity visibility' },
  { name: 'Finance & fintech', short: 'Finance & fintech', copy: 'Reduce operational drag around approvals, reporting, and risk without treating control as a blocker.', detail: 'Exception handling · controls · management information' },
  { name: 'Technology', short: 'Technology', copy: 'Give a growing team a calmer operating layer so product and customer work can move at the right speed.', detail: 'Internal tooling · customer operations · workflow design' },
  { name: 'Sales & marketing', short: 'Sales & marketing', copy: 'Turn scattered signals into a dependable path from first conversation to a customer who stays.', detail: 'Pipeline hygiene · campaign handoffs · retention signals' },
];

type FormData = { name: string; email: string; company: string; challenge: string; timing: ConsultationInputTiming };
type FormErrors = Partial<Record<keyof FormData, string>>;

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        node.classList.add('is-visible');
        observer.disconnect();
      }
    }, { threshold: 0.12 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useReveal();
  return <div ref={ref} className={`reveal ${className}`}>{children}</div>;
}

function Logo() {
  return (
    <a href="#top" aria-label="Raphah.io home" className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]">
        <span className="display text-lg font-bold leading-none">R</span>
      </span>
      <span className="text-[1.03rem] font-bold tracking-[-.04em]">raphah<span className="text-[hsl(var(--accent))]">.</span>io</span>
    </a>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <div className="container-wide flex h-[78px] items-center justify-between">
        <Logo />
        <nav className="hidden items-center gap-8 text-[.78rem] font-semibold md:flex" aria-label="Main navigation">
          <a className="nav-link" href="#approach">How we work</a>
          <a className="nav-link" href="#focus">Where we help</a>
          <a className="nav-link" href="#principles">What matters</a>
        </nav>
        <a href="#conversation" className="btn-primary hidden md:inline-flex">Start a conversation <ArrowUpRight size={15} /></a>
        <button
          type="button"
          className="rounded-full p-2 md:hidden"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {open && (
        <div className="mobile-panel absolute inset-x-4 top-[68px] rounded-2xl border bg-[hsl(var(--card))] p-5 md:hidden">
          <nav className="flex flex-col gap-1" aria-label="Mobile navigation">
            {[
              ['How we work', '#approach'],
              ['Where we help', '#focus'],
              ['What matters', '#principles'],
            ].map(([label, href]) => (
              <a key={href} href={href} onClick={close} className="rounded-xl px-3 py-3 text-sm font-semibold hover:bg-[hsl(var(--muted))]">{label}</a>
            ))}
            <a href="#conversation" onClick={close} className="btn-primary mt-3">Start a conversation <ArrowUpRight size={15} /></a>
          </nav>
        </div>
      )}
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden border-b bg-[hsl(var(--background))]">
      <div className="hero-grid absolute inset-0 opacity-60" aria-hidden="true" />
      <div className="container-wide relative grid min-h-[720px] items-center gap-14 pb-16 pt-32 lg:grid-cols-[1.04fr_.96fr] lg:pb-20 lg:pt-36">
        <div>
          <Reveal>
            <div className="mb-7 flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-[hsl(var(--accent))] pulse-dot" />
              <span className="eyebrow">Operating partner for complicated work</span>
            </div>
          </Reveal>
          <Reveal className="delay-1">
            <h1 className="display max-w-[700px] text-[clamp(3.5rem,8vw,7.2rem)] font-semibold leading-[.92] text-[hsl(var(--primary))]">
              Make the work<br /><em className="font-medium not-italic text-[hsl(var(--accent))]">make sense.</em>
            </h1>
          </Reveal>
          <Reveal className="delay-2">
            <p className="mt-8 max-w-[510px] text-[1.08rem] leading-[1.65] text-[hsl(var(--muted-foreground))]">
              Raphah helps founder-led teams turn operational friction into clear AI and business-systems improvements — grounded in evidence, shaped for the real world.
            </p>
          </Reveal>
          <Reveal className="delay-3">
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <a href="#conversation" className="btn-primary">Talk through the knot <ArrowUpRight size={15} /></a>
              <a href="#approach" className="arrow-link px-2 py-3">See the approach <ArrowDown size={15} /></a>
            </div>
          </Reveal>
          <Reveal className="delay-4">
            <div className="mt-14 flex flex-wrap gap-x-7 gap-y-3 border-t pt-5">
              <span className="eyebrow flex items-center gap-2"><Check size={13} className="text-[hsl(var(--accent))]" /> Evidence before advice</span>
              <span className="eyebrow flex items-center gap-2"><Check size={13} className="text-[hsl(var(--accent))]" /> Human approval built in</span>
            </div>
          </Reveal>
        </div>

        <Reveal className="delay-2">
          <div className="relative mx-auto w-full max-w-[500px] lg:ml-auto">
            <div className="absolute -inset-4 rounded-[2rem] bg-[hsl(var(--secondary)/.22)] blur-2xl" />
            <div className="relative overflow-hidden rounded-[1.6rem] border bg-[hsl(var(--card))] p-5 shadow-[0_24px_70px_hsl(203_39%_15%/.11)]">
              <div className="flex items-center justify-between border-b pb-4">
                <div className="flex items-center gap-2">
                  <ScanLine size={15} className="text-[hsl(var(--accent))]" />
                  <span className="mono text-[.62rem] text-[hsl(var(--muted-foreground))]">Operating picture / 01</span>
                </div>
                <span className="rounded-full bg-[hsl(var(--secondary)/.4)] px-2 py-1 text-[.62rem] font-bold text-[hsl(var(--primary))]">In focus</span>
              </div>
              <div className="relative my-7 aspect-square overflow-hidden rounded-xl bg-[hsl(var(--primary))]">
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 420 340" fill="none" aria-label="Abstract operating system map">
                  <path d="M32 77H115M220 77h80M132 170h74M284 170h93M81 264h82M226 264h114" stroke="#496072" strokeWidth="1" />
                  <path d="M115 77l17 93m88-93l-16 93m80-93l-4 93m-11 0l-42 94m-63-94l-1 94" stroke="#6c8290" strokeWidth="1" strokeDasharray="3 5" />
                  <circle cx="28" cy="77" r="4" fill="#C8EB62" /><circle cx="119" cy="77" r="4" fill="#F4F0E8" />
                  <circle cx="224" cy="77" r="4" fill="#C8EB62" /><circle cx="304" cy="77" r="4" fill="#F4F0E8" />
                  <circle cx="132" cy="170" r="6" fill="#E9765C" /><circle cx="209" cy="170" r="6" fill="#C8EB62" />
                  <circle cx="284" cy="170" r="4" fill="#F4F0E8" /><circle cx="377" cy="170" r="4" fill="#C8EB62" />
                  <circle cx="81" cy="264" r="4" fill="#F4F0E8" /><circle cx="163" cy="264" r="4" fill="#C8EB62" />
                  <circle cx="226" cy="264" r="4" fill="#F4F0E8" /><circle cx="340" cy="264" r="4" fill="#E9765C" />
                  <circle cx="209" cy="170" r="28" stroke="#C8EB62" strokeOpacity=".45" strokeDasharray="2 5" className="hero-orbit" />
                  <text x="25" y="55" fill="#92A4AC" fontSize="10" fontFamily="DM Mono">signal</text>
                  <text x="178" y="202" fill="#F4F0E8" fontSize="11" fontFamily="DM Sans">the knot</text>
                  <text x="303" y="299" fill="#92A4AC" fontSize="10" fontFamily="DM Mono">next move</text>
                </svg>
                <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between border-t border-white/15 pt-3">
                  <span className="mono text-[.58rem] text-[#92A4AC]">Visibility → decision</span>
                  <span className="flex items-center gap-1.5 text-[.62rem] text-[#C8EB62]"><span className="h-1.5 w-1.5 rounded-full bg-[#C8EB62]" /> Live context</span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {['Observe', 'Clarify', 'Improve'].map((item, i) => <div key={item} className="rounded-lg bg-[hsl(var(--muted))] p-2.5"><span className="mono text-[.55rem] text-[hsl(var(--muted-foreground))]">0{i + 1}</span><p className="mt-2 text-[.72rem] font-bold">{item}</p></div>)}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
      <div className="container-wide relative flex items-center justify-between border-t py-5">
        <span className="eyebrow">For leaders who have outgrown workarounds</span>
        <span className="mono hidden text-[.62rem] text-[hsl(var(--muted-foreground))] sm:block">R / 2025</span>
      </div>
    </section>
  );
}

function Friction() {
  const items = [
    ['01', 'The work lives in people’s heads.', 'When the answer to “how do we do this?” is a particular person, growth becomes fragile.'],
    ['02', 'The tools multiplied. The clarity did not.', 'More software rarely solves a process nobody has mapped. It can make the blur harder to see.'],
    ['03', 'The next improvement is hard to trust.', 'You need to know what is actually happening before introducing automation or AI into the mix.'],
  ];
  return (
    <section className="section-space bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
      <div className="container-wide">
        <Reveal><div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]"><div><span className="eyebrow text-[#A6B7BC]">A familiar pattern</span></div><h2 className="display max-w-[700px] text-[clamp(2.6rem,5vw,5.1rem)] leading-[.98]">Complexity is not the problem.<br /><span className="text-[#C8EB62]">Invisible complexity is.</span></h2></div></Reveal>
        <div className="mt-20 grid gap-0 border-t border-white/20 md:grid-cols-3">
          {items.map(([number, title, copy], i) => <Reveal key={number} className={`delay-${i + 1}`}><article className="border-b border-white/20 py-8 md:min-h-[260px] md:border-b-0 md:border-r md:px-7 md:first:pl-0 md:last:border-r-0"><span className="mono text-[.63rem] text-[#C8EB62]">{number}</span><h3 className="display mt-12 max-w-[250px] text-[1.7rem] leading-[1.05]">{title}</h3><p className="mt-5 max-w-[270px] text-[.84rem] leading-[1.6] text-[#A6B7BC]">{copy}</p></article></Reveal>)}
        </div>
      </div>
    </section>
  );
}

function Approach() {
  const steps = [
    { no: '01', title: 'See what is really happening.', body: 'We listen, observe, and map the work as it is — across systems, handoffs, decisions, and exceptions. No assumptions dressed up as strategy.', icon: ScanLine, tag: 'Evidence-led discovery' },
    { no: '02', title: 'Choose the moves that matter.', body: 'We turn what we find into a practical sequence: what to change now, what to test next, and what should stay human for good reason.', icon: Sparkles, tag: 'Clear roadmaps' },
    { no: '03', title: 'Make the improvement stick.', body: 'We work alongside your team to implement, explain, and refine. The goal is a better operating habit — not another dependency.', icon: Users, tag: 'Human-guided implementation' },
  ];
  return (
    <section id="approach" className="section-space">
      <div className="container-wide">
        <Reveal><div className="max-w-[760px]"><span className="eyebrow">A calm way through</span><h2 className="display mt-5 text-[clamp(2.8rem,6vw,5.8rem)] leading-[.94]">From “something is off”<br /><span className="text-[hsl(var(--accent))]">to a way forward.</span></h2><p className="mt-7 max-w-[550px] text-[1.05rem] leading-[1.7] text-[hsl(var(--muted-foreground))]">The work is deliberately collaborative. You bring the context; we bring a clear outside view and the structure to act on it.</p></div></Reveal>
        <div className="mt-20 grid gap-4 lg:grid-cols-3">
          {steps.map(({ no, title, body, icon: Icon, tag }, i) => <Reveal key={no} className={`delay-${i + 1}`}><article className="lift group relative flex min-h-[350px] flex-col rounded-[1.3rem] border bg-[hsl(var(--card))] p-7"><div className="flex items-center justify-between"><span className="mono text-[.62rem] text-[hsl(var(--muted-foreground))]">{no}</span><span className="flex h-10 w-10 items-center justify-center rounded-full bg-[hsl(var(--secondary)/.45)] text-[hsl(var(--primary))]"><Icon size={19} /></span></div><div className="mt-auto"><span className="eyebrow text-[hsl(var(--accent))]">{tag}</span><h3 className="display mt-3 text-[2rem] leading-[1]">{title}</h3><p className="mt-4 text-[.87rem] leading-[1.65] text-[hsl(var(--muted-foreground))]">{body}</p></div><ChevronRight className="absolute bottom-7 right-7 opacity-0 transition-opacity group-hover:opacity-100" size={18} /></article></Reveal>)}
        </div>
      </div>
    </section>
  );
}

function Focus() {
  const [selected, setSelected] = useState(0);
  const current = industries[selected];
  return (
    <section id="focus" className="section-space border-y bg-[hsl(var(--muted)/.55)]">
      <div className="container-wide">
        <Reveal><div className="grid gap-12 lg:grid-cols-[.7fr_1.3fr]"><div><span className="eyebrow">Where we help</span><h2 className="display mt-5 text-[clamp(2.8rem,5vw,5rem)] leading-[.95]">Different sectors.<br /><span className="text-[hsl(var(--accent))]">Same need for clarity.</span></h2></div><div className="lg:pt-12"><p className="max-w-[580px] text-[1.12rem] leading-[1.6]">The details change. The underlying work is familiar: decisions moving through people, systems, and imperfect information.</p><div className="mt-10 flex flex-wrap gap-2" role="tablist" aria-label="Industries we support">{industries.map((industry, i) => <button key={industry.name} type="button" role="tab" aria-selected={selected === i} className="industry-pill rounded-full border px-4 py-2.5 text-[.75rem] font-bold" onClick={() => setSelected(i)}>{industry.short}</button>)}</div></div></div></Reveal>
        <Reveal className="delay-2"><div className="mt-16 grid gap-8 rounded-[1.5rem] bg-[hsl(var(--primary))] p-7 text-[hsl(var(--primary-foreground))] sm:p-10 lg:grid-cols-[.8fr_1.2fr] lg:p-14"><div><span className="mono text-[.62rem] text-[#C8EB62]">In practice</span><div className="mt-8 flex items-center gap-3"><span className="h-3 w-3 rounded-full bg-[#E9765C]" /><span className="text-sm font-semibold">{current.name}</span></div></div><div><h3 className="display max-w-[620px] text-[clamp(2rem,4vw,3.8rem)] leading-[1.02]">{current.copy}</h3><p className="mt-8 border-t border-white/20 pt-5 text-[.7rem] text-[#A6B7BC]">{current.detail}</p></div></div></Reveal>
      </div>
    </section>
  );
}

function Principles() {
  return (
    <section id="principles" className="section-space">
      <div className="container-wide">
        <Reveal><div className="flex flex-col justify-between gap-8 border-b pb-10 md:flex-row md:items-end"><div><span className="eyebrow">The Raphah standard</span><h2 className="display mt-5 max-w-[650px] text-[clamp(2.8rem,5vw,5.2rem)] leading-[.94]">Useful beats impressive.<br /><span className="text-[hsl(var(--accent))]">Every time.</span></h2></div><p className="max-w-[330px] text-[.9rem] leading-[1.6] text-[hsl(var(--muted-foreground))]">We are interested in work that makes Monday morning feel different — not work that only looks good in a deck.</p></div></Reveal>
        <div className="grid gap-0 md:grid-cols-3">
          {[
            { icon: ShieldCheck, title: 'Privacy-aware by default', body: 'Discovery starts with the minimum information needed. Sensitive context is handled with care, clear boundaries, and no casual data grabs.' },
            { icon: ScanLine, title: 'Evidence earns the right to act', body: 'We make the current state visible before recommending tools, automations, or AI. The signal comes before the solution.' },
            { icon: Users, title: 'People stay in the loop', body: 'Automation should increase judgment, not hide it. Human approval and ownership are designed into the workflow from the start.' },
          ].map(({ icon: Icon, title, body }, i) => <Reveal key={title} className={`delay-${i + 1}`}><article className="border-b py-10 md:min-h-[300px] md:border-b-0 md:border-r md:px-8 md:first:pl-0 md:last:border-r-0"><Icon size={22} strokeWidth={1.5} className="text-[hsl(var(--accent))]" /><h3 className="mt-10 max-w-[220px] text-[1.08rem] font-bold">{title}</h3><p className="mt-4 max-w-[255px] text-[.86rem] leading-[1.65] text-[hsl(var(--muted-foreground))]">{body}</p></article></Reveal>)}
        </div>
      </div>
    </section>
  );
}

function Conversation() {
  const [form, setForm] = useState<FormData>({ name: '', email: '', company: '', challenge: '', timing: 'Exploring' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const update = (key: keyof FormData, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
    if (serverError) setServerError('');
  };
  const consultationMutation = useCreateConsultation({
    mutation: {
      onSuccess: () => {
        setServerError('');
        setSubmitted(true);
      },
      onError: () => {
        setServerError('We could not send that just now. Please try again in a moment.');
      },
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (consultationMutation.isPending) return;
    const next: FormErrors = {};
    if (!form.name.trim()) next.name = 'Tell us who we will be speaking with.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = 'Please enter a valid email address.';
    if (!form.company.trim()) next.company = 'A company name helps us prepare.';
    if (form.challenge.trim().length < 20) next.challenge = 'A little more detail helps us make the first conversation useful.';
    setErrors(next);
    setServerError('');
    if (Object.keys(next).length === 0) {
      consultationMutation.mutate({
        data: {
          fullName: form.name.trim(),
          email: form.email.trim(),
          company: form.company.trim(),
          challenge: form.challenge.trim(),
          timing: form.timing,
        },
      });
    }
  };
  return (
    <section id="conversation" className="section-space bg-[hsl(var(--secondary))]">
      <div className="container-wide">
        <div className="grid gap-14 lg:grid-cols-[.85fr_1.15fr] lg:gap-24">
          <Reveal><div><span className="eyebrow text-[hsl(var(--primary)/.7)]">A good first step</span><h2 className="display mt-5 text-[clamp(3rem,6vw,6rem)] leading-[.9] text-[hsl(var(--primary))]">Bring the<br /><span className="text-[hsl(var(--accent))]">complicated</span><br />thing.</h2><p className="mt-8 max-w-[390px] text-[.98rem] leading-[1.7] text-[hsl(var(--primary)/.75)]">Tell us what feels harder than it should. We will come prepared with questions, not a pre-written package.</p><div className="mt-12 border-t border-[hsl(var(--primary)/.18)] pt-5"><p className="eyebrow text-[hsl(var(--primary)/.62)]">Engagements are shaped around</p><p className="mt-3 text-[.88rem] font-bold text-[hsl(var(--primary))]">your context, your pace, your team.</p></div></div></Reveal>
          <Reveal className="delay-2"><div className="rounded-[1.4rem] bg-[hsl(var(--card))] p-6 shadow-[0_20px_60px_hsl(203_39%_15%/.1)] sm:p-9">{submitted ? <div className="success-panel flex min-h-[470px] flex-col justify-between"><div><div className="flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--secondary))] text-[hsl(var(--primary))]"><Check size={23} /></div><h3 className="display mt-10 text-[2.8rem] leading-[.98]">That is a useful<br />place to start.</h3><p className="mt-6 max-w-[390px] text-[.9rem] leading-[1.65] text-[hsl(var(--muted-foreground))]">Thanks, {form.name.split(' ')[0] || 'there'}. Your consultation request is in. We will be in touch with a thoughtful next step.</p></div><button type="button" className="arrow-link self-start" onClick={() => { setSubmitted(false); setErrors({}); setServerError(''); setForm({ name: '', email: '', company: '', challenge: '', timing: 'Exploring' }); }}>Send another note <ArrowUpRight size={15} /></button></div> : <form onSubmit={submit} noValidate aria-busy={consultationMutation.isPending}><div className="mb-8 flex items-center justify-between border-b pb-5"><span className="sr-only" role="status" aria-live="polite">{consultationMutation.isPending ? 'Sending your consultation request.' : serverError}</span><span className="mono text-[.62rem] text-[hsl(var(--muted-foreground))]">Conversation request</span><span className="text-[.7rem] text-[hsl(var(--muted-foreground))]">Takes about 2 minutes</span></div><div className="grid gap-5 sm:grid-cols-2"><div><label className="form-label" htmlFor="name">Your name</label><input id="name" className="form-field" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="Amina Okafor" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'name-error' : undefined} />{errors.name && <p id="name-error" className="form-error">{errors.name}</p>}</div><div><label className="form-label" htmlFor="email">Work email</label><input id="email" type="email" className="form-field" value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="amina@company.com" aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} />{errors.email && <p id="email-error" className="form-error">{errors.email}</p>}</div><div><label className="form-label" htmlFor="company">Company</label><input id="company" className="form-field" value={form.company} onChange={(e) => update('company', e.target.value)} placeholder="Your business" aria-invalid={!!errors.company} aria-describedby={errors.company ? 'company-error' : undefined} />{errors.company && <p id="company-error" className="form-error">{errors.company}</p>}</div><div><label className="form-label" htmlFor="timing">Where are you in the journey?</label><select id="timing" className="form-field" value={form.timing} onChange={(e) => update('timing', e.target.value)}><option>Exploring</option><option>Ready to make a change</option><option>Already working on it</option><option>Not sure yet</option></select></div><div className="sm:col-span-2"><label className="form-label" htmlFor="challenge">What are you trying to make easier?</label><textarea id="challenge" rows={5} className="form-field resize-y" value={form.challenge} onChange={(e) => update('challenge', e.target.value)} placeholder="We spend too much time..." aria-invalid={!!errors.challenge} aria-describedby={errors.challenge ? 'challenge-error' : undefined} />{errors.challenge && <p id="challenge-error" className="form-error">{errors.challenge}</p>}</div></div><div className="mt-7 flex flex-col items-start justify-between gap-5 border-t pt-6 sm:flex-row sm:items-center"><p className="max-w-[270px] text-[.68rem] leading-[1.5] text-[hsl(var(--muted-foreground))]">Your details are used only to follow up on this request. No mailing list. No automated sales sequence.</p>{serverError && <p className="form-error">{serverError}</p>}<button type="submit" className="btn-primary shrink-0" disabled={consultationMutation.isPending}>{consultationMutation.isPending ? 'Sending context…' : <>Send the context <ArrowUpRight size={15} /></>}</button></div></form>}</div></Reveal>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return <footer className="bg-[hsl(var(--primary))] py-10 text-[hsl(var(--primary-foreground))]"><div className="container-wide flex flex-col justify-between gap-8 sm:flex-row sm:items-end"><div><Logo /><p className="mt-5 max-w-[270px] text-[.73rem] leading-[1.6] text-[#A6B7BC]">Clearer systems for businesses doing meaningful, complicated work.</p></div><div className="flex flex-col gap-3 sm:items-end"><a href="#top" className="arrow-link text-[#F4F0E8]">Back to top <ArrowUpRight size={15} /></a><span className="mono text-[.58rem] text-[#7F969D]">© {new Date().getFullYear()} Raphah.io</span></div></div></footer>;
}

function Home() {
  useEffect(() => {
    document.title = 'Raphah.io — Make the work make sense.';
    const description = document.querySelector('meta[name="description"]') ?? document.createElement('meta');
    description.setAttribute('name', 'description');
    description.setAttribute('content', 'Raphah helps founder-led teams turn operational friction into clear AI and business-systems improvements.');
    if (!description.parentNode) document.head.appendChild(description);
  }, []);
  return <div className="site-shell noise"><Header /><main><Hero /><Friction /><Approach /><Focus /><Principles /><Conversation /></main><Footer /></div>;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
