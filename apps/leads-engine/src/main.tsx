import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const opportunities = [
  { name: 'Northstar Health', signal: 'New digital intake programme', score: 92, stage: 'Qualified', source: 'Public tender' },
  { name: 'Field & Form', signal: 'Hiring for operations transformation', score: 84, stage: 'Discovery', source: 'Referral' },
  { name: 'Atlas Civic Lab', signal: 'Service redesign grant awarded', score: 77, stage: 'New', source: 'Approved feed' },
];

function App() {
  return <div className="app-shell lead-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">R</span><span>Raphah</span></div><div className="product-label">LEAD ENGINE <span>v1</span></div><nav><a className="active">Overview <b>⌘1</b></a><a>Opportunities <strong>24</strong></a><a>Organizations</a><a>Discovery sessions</a><a>Requirements</a><a>Handoffs <strong className="green">3</strong></a></nav><div className="sidebar-bottom"><a>Audit & evidence</a><a>Settings</a><div className="user"><span>DM</span><div><b>Dude D.</b><small>Operator</small></div><i>•••</i></div></div></aside>
    <main><header className="topbar"><div><p className="eyebrow">Workspace / Revenue pipeline</p><h1>Opportunity command center</h1></div><div className="top-actions"><button className="quiet">Last 30 days⌄</button><button className="primary">+ New opportunity</button></div></header>
      <div className="content"><section className="hero-row"><div><p className="eyebrow accent">Tuesday, 17 September 2026</p><h2>Good morning, Dude.</h2><p className="muted">Your pipeline is moving. Three opportunities are ready for a human review.</p></div><div className="signal-box"><span className="pulse"></span><div><b>Source health</b><small>All approved sources active</small></div><span className="arrow">↗</span></div></section>
      <section className="metrics"><Metric label="Qualified pipeline" value="£186k" change="+18.4%"/><Metric label="Open opportunities" value="24" change="+6 this week"/><Metric label="Discovery sessions" value="8" change="3 need notes" warn/><Metric label="Handoff readiness" value="67%" change="2 baselines ready"/></section>
      <div className="grid-main"><section className="panel opportunities"><div className="panel-head"><div><h3>Priority opportunities</h3><p>Ranked by fit, evidence, and recency</p></div><button className="text-button">View pipeline →</button></div><div className="table"><div className="table-head"><span>Opportunity</span><span>Signal</span><span>Fit score</span><span>Stage</span></div>{opportunities.map((o) => <div className="table-row" key={o.name}><div className="op-name"><span className="avatar">{o.name.slice(0,2)}</span><div><b>{o.name}</b><small>{o.source}</small></div></div><span className="signal">{o.signal}</span><span className="score"><i style={{width: `${o.score}%`}}></i>{o.score}</span><span className={`badge ${o.stage.toLowerCase()}`}>{o.stage}</span></div>)}</div></section><section className="panel activity"><div className="panel-head"><div><h3>Today’s focus</h3><p>Human actions keep the system honest</p></div></div><div className="focus-item"><span className="icon amber">!</span><div><b>Validate 4 source findings</b><small>Due before next source run</small></div><span>›</span></div><div className="focus-item"><span className="icon blue">◷</span><div><b>Complete Northstar notes</b><small>Discovery session · 42 min</small></div><span>›</span></div><div className="focus-item"><span className="icon green">✓</span><div><b>Approve handoff baseline</b><small>Field & Form · v1.2</small></div><span>›</span></div></section></div>
      </div></main></div>
}
function Metric({label,value,change,warn=false}:{label:string,value:string,change:string,warn?:boolean}) { return <div className="metric"><p>{label}</p><strong>{value}</strong><small className={warn ? 'warn' : 'up'}>{warn ? '• ' : '↗ '}{change}</small></div> }
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
