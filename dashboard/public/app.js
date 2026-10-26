const state = {
  view: 'overview', overview: null, jobs: [], jobTotal: 0, jobOffset: 0, jobLimit: 50,
  events: [], eventTotal: 0, eventOffset: 0, eventLimit: 80, artifacts: [], artifactTotal: 0, artifactOffset: 0, artifactLimit: 80,
  jobQuery: '', statusFilter: '', phaseFilter: '', eventQuery: '', eventType: '', artifactQuery: '', artifactType: '', filePath: '', selectedEvent: null, selectedArtifact: null,
  currentJob: null, jobTab: 'tasks', autoRefresh: true, lastSync: null, attentionJobs: [], attentionFilter: 'all', pinnedJobs: new Set(), filePreviewPath: '',
  roles: null, roleQuery: '', roleVersions: 'latest', selectedRoleKey: null,
  policies: null, policyQuery: '', policyVersions: 'latest',
  batches: [], batchTotal: 0, batchOffset: 0, batchLimit: 50, batchQuery: '', batchStatus: '', selectedBatchId: null,
  individualExecutions: [], individualExecutionTotal: 0, individualExecutionOffset: 0, individualExecutionLimit: 50,
  aggGraph: null, aggSelectedNode: null, aggNodeDetail: null, aggZoom: 1, aggSearch: '', aggGoal: '', aggType: '', aggIncludeRecovery: false, aggShowNeighborhood: false,
  aggRuns: [], aggRunTotal: 0, aggRunOffset: 0, aggRunLimit: 20, aggRunQuery: '', aggRunStatus: '', aggRunTool: '',
  aggRunSince: '', aggRunUntil: '', aggRunGoal: '', aggRunNode: '', aggRunGoalOptions: new Set(),
  aggRunSelected: null, aggRunDetail: null, aggRunDetailRefreshing: false, aggRelatedRunsNode: null, aggRunEvents: [], aggRunEventsMore: false, aggRunGraphRunId: null, aggRunGraphQuery: '', aggRunGraphType: '', aggRunGraphZoom: 100, aggRunGraphSelectedNode: null
};
const SESSION_KEY = 'orbit-dashboard-session-v1';
const STALE_AFTER_MS = 15 * 60 * 1000;
function loadSessionPrefs() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch { return {}; }
}
const sessionPrefs = loadSessionPrefs();
state.jobQuery = typeof sessionPrefs.jobQuery === 'string' ? sessionPrefs.jobQuery : '';
state.statusFilter = typeof sessionPrefs.statusFilter === 'string' ? sessionPrefs.statusFilter : '';
state.phaseFilter = typeof sessionPrefs.phaseFilter === 'string' ? sessionPrefs.phaseFilter : '';
state.pinnedJobs = new Set(Array.isArray(sessionPrefs.pinnedJobs) ? sessionPrefs.pinnedJobs.filter(x => typeof x === 'string') : []);
const $ = id => document.getElementById(id);
const views = ['overview','agg','workflows','roles','policies','batches','events','artifacts','files'];
let toastTimer = null;
let pollTimer = null;
let refreshInFlight = false;

function el(tag, cls = '', value = undefined) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (value !== undefined && value !== null) n.textContent = String(value);
  return n;
}
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); return parent; }
function clear(n) { n.replaceChildren(); }
function fmtNumber(n) { return Number(n || 0).toLocaleString(); }
function ago(value) {
  if (!value) return '—';
  const t = Date.parse(value); if (!Number.isFinite(t)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now()-t)/1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`;
  if (seconds < 86400*30) return `${Math.floor(seconds/86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:undefined});
}
function compactId(value, max = 15) { const s=String(value || '—'); return s.length>max?`${s.slice(0,Math.ceil(max/2))}…${s.slice(-Math.floor(max/2))}`:s; }
function statusClass(value) { const s=String(value||'pending').toLowerCase(); if (s.includes('fail')||s.includes('error')||s.includes('reject')) return 'status-failed'; if(s.includes('complete')||s.includes('success')||s==='accept') return 'status-completed'; if(s==='active'||s==='running'||s==='executing'||s==='spawning'||s==='assign_children') return 'status-active'; if(s==='cancelled'||s==='pending'||s==='waiting'||s.includes('await')) return 'status-pending'; return 'status-live'; }
function pill(value) { return el('span', `status-pill ${statusClass(value)}`, String(value || 'unknown').replaceAll('_',' ')); }
function saveSessionPrefs() {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({jobQuery:state.jobQuery,statusFilter:state.statusFilter,phaseFilter:state.phaseFilter,pinnedJobs:[...state.pinnedJobs]})); } catch {}
}
function relativeTime(value) {
  const node=el('time','',ago(value));
  if(value){node.dateTime=String(value);node.title=dateTime(value);}
  return node;
}
function jobStatus(job) { return String(job?.status || job?.state || '').toLowerCase(); }
function isFailedJob(job) { return /fail|error|reject|blocked/.test(jobStatus(job)); }
function isActiveJob(job) { return /^(active|running|executing|in[._ -]?progress|spawning|assign_children)$/.test(jobStatus(job)); }
function isStaleJob(job, now=Date.now()) {
  if(!isActiveJob(job) || !job?.updated_at) return false;
  const stamp=Date.parse(job.updated_at);
  return Number.isFinite(stamp) && now-stamp>STALE_AFTER_MS;
}
function copyButton(value,label='Copy') {
  const button=el('button','copy-button',label);button.type='button';button.title=`Copy ${label.toLowerCase()}`;
  button.addEventListener('click',event=>{event.stopPropagation();copyText(value,label).catch(()=>{});});
  return button;
}
async function copyText(value,label='value') {
  const text=String(value??'');if(!text){notify(`Nothing to copy`,true);return false;}
  try {
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);notify(`${label} copied`);return true;}
  } catch {}
  let ok=false;const input=el('textarea','copy-fallback');input.value=text;input.setAttribute('aria-label',`Copy ${label}`);document.body.append(input);input.focus();input.select();
  try { ok=Boolean(document.execCommand('copy')); } catch { ok=false; }
  input.remove();notify(ok?`${label} copied`:`Copy unavailable — select the value in its detail view`,!ok);return ok;
}
function togglePinned(jobId, job=null) {
  if(state.pinnedJobs.has(jobId))state.pinnedJobs.delete(jobId);else {
    if(state.pinnedJobs.size>=20){notify('Session pins are limited to 20 workflows',true);return;}
    state.pinnedJobs.add(jobId);
  }
  if(job&&!state.attentionJobs.some(x=>x.job_id===jobId))state.attentionJobs.push(job);
  saveSessionPrefs();renderAttentionList();
  if(state.view==='workflows')renderJobsTable(state.jobs,$('all-jobs'),openJob,'all');
  notify(state.pinnedJobs.has(jobId)?'Added to session pins':'Removed from session pins');
}
function pinButton(job) {
  const pinned=state.pinnedJobs.has(job.job_id),button=el('button',`pin-button${pinned?' pinned':''}`,pinned?'★':'☆');
  button.type='button';button.title=pinned?'Unpin workflow':'Pin workflow for this session';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(pinned));
  button.addEventListener('click',event=>{event.stopPropagation();togglePinned(job.job_id,job);});return button;
}
function notify(message, error = false) {
  const t=$('toast'); t.textContent=message; t.className=`toast show${error?' error':''}`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2800);
}
async function api(path) {
  const response = await fetch(path, { method:'GET', credentials:'same-origin', headers:{'accept':'application/json'} });
  const data = await response.json().catch(()=>({error:'Invalid response from local dashboard'}));
  if (!response.ok) throw new Error(data.details || data.error || `Request failed (${response.status})`);
  return data;
}
function setBanner(message = '') {
  const n=$('connection-banner');
  if(!message){n.classList.add('hidden');n.textContent='';return;}
  n.textContent=message;n.classList.remove('hidden');
}
function setSyncUi(mode) {
  const label=$('last-updated');
  label.dataset.syncState=mode;
  const busy=mode==='syncing';
  for(const button of [$('refresh-button'),$('hero-refresh')]) {
    button.classList.toggle('is-refreshing',busy);
    button.disabled=busy;
    button.setAttribute('aria-busy',String(busy));
    button.title=busy?'Refreshing the local snapshot':'Refresh dashboard snapshot';
  }
  if(mode==='syncing' && !state.lastSync) label.textContent='SYNCING SNAPSHOT';
  if(mode==='error') {
    if(state.lastSync) {
      label.title=`Refresh failed. Last successful snapshot: ${dateTime(state.lastSync.toISOString())}`;
    } else {
      label.textContent='SYNC FAILED';
      label.title='No successful snapshot has been loaded yet.';
    }
  }
}
function updateHero(title, accent, subtitle) {
  const h=$('page-title'); clear(h); h.append(document.createTextNode(`${title} `), el('em','',accent)); $('page-subtitle').textContent=subtitle;
}
function setView(view) {
  if(!views.includes(view)) return;
  state.view=view;
  try {
    const url=new URL(window.location.href);url.searchParams.set('view',view);url.searchParams.delete('wb');
    window.history.replaceState(window.history.state,'',`${url.pathname}${url.search}${url.hash}`);
  } catch {}
  for(const v of views) $(`${v}-view`).classList.toggle('hidden',v!==view);
  if(view==='workflows'){
    const detail=$('job-detail-shell');if(detail)detail.remove();state.currentJob=null;
    $('workflows-view').querySelector('.section-toolbar')?.classList.remove('hidden');$('workflows-view').querySelector('.table-panel')?.classList.remove('hidden');
  }
  document.querySelectorAll('.nav-item').forEach(b=>{
    const active=b.dataset.view===view;
    b.classList.toggle('active',active);
    if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  });
  const meta={overview:['Operations','Overview','Workflow health, recent activity and exceptions.'],agg:['Adaptive Goal','Graph','Inspect persisted AGG knowledge, provenance, revisions and unresolved trust.'],workflows:['Workflows','Registry','Search, filter and inspect workflow runs.'],roles:['Role','Registry','Saved role versions, skill snapshots and custom workflow pins.'],policies:['Workflow','Policies','Reusable policy packs, immutable versions and workflow attachments.'],batches:['Batch','Execution','Durable command batches and per-item execution evidence.'],events:['Events','Stream','Recent events across workflow runs.'],artifacts:['Artifacts','Library','Stored results and evidence.'],files:['Workspace','Files','Read-only text and log previews.']}[view];
  updateHero(...meta); $('crumb-current').textContent=({overview:'Overview',agg:'AGG Graph',workflows:'Workflows',roles:'Roles & skills',policies:'Policies',batches:'Batch execution',events:'Event stream',artifacts:'Artifacts',files:'Workspace files'})[view];
  if(view==='agg') loadAggGraph(); if(view==='workflows') loadJobs(); if(view==='roles') loadRoles(); if(view==='policies') loadPolicies(); if(view==='batches') loadBatches(); if(view==='events') loadEvents(); if(view==='artifacts') loadArtifacts(); if(view==='files') loadFiles(state.filePath);
  if(view==='overview') renderOverview();
}
function setCountsText(id, count) { $(id).textContent=fmtNumber(count); }
function mapCount(rows,key,value='count') { return Object.fromEntries((rows||[]).map(r=>[r[key],Number(r[value]||0)])); }
function getJobStatusCount(o,status) { return mapCount(o?.job_statuses,'status')[status]||0; }
function getTaskStatusCount(o,status) { return mapCount(o?.task_statuses,'status')[status]||0; }
function updateSparks(counts) {
  const variants=[['spark-jobs','jobs'],['spark-tasks','tasks'],['spark-events','events'],['spark-artifacts','artifacts']];
  for(const [id,key] of variants) { const target=$(id); clear(target); const arr=(counts||[]).slice(-9); const max=Math.max(1,...arr.map(x=>Number(x.count)||0)); for(const x of arr){const b=el('i');b.style.cssText=`display:inline-block;vertical-align:bottom;width:3px;margin-right:2px;height:${Math.max(2,12*Number(x.count||0)/max)}px;background:currentColor;opacity:.45`;target.append(b);} }
}
function renderActivityChart(activity) {
  const c=$('activity-chart');clear(c); const days=[]; const today=new Date(); today.setUTCHours(0,0,0,0);
  for(let i=13;i>=0;i--){const d=new Date(today);d.setUTCDate(today.getUTCDate()-i);const day=d.toISOString().slice(0,10);days.push({day,count:0});}
  const lookup=Object.fromEntries((activity||[]).map(a=>[a.day,Number(a.count||0)]));days.forEach(d=>d.count=lookup[d.day]||0);
  const max=Math.max(1,...days.map(x=>x.count));
  for(let i=0;i<days.length;i++){const d=days[i];const b=el('div',`activity-bar${i===days.length-1?' today':''}`);b.style.height=`${Math.max(4,Math.round(70*d.count/max))}px`;b.title=`${d.day}: ${fmtNumber(d.count)} events`;b.setAttribute('aria-label',b.title);c.append(b);}
  $('events-seven-days').textContent=fmtNumber((activity||[]).reduce((n,x)=>n+Number(x.count||0),0));
}
function workflowCell(job) {
  const wrap=el('div','workflow-name');append(wrap,el('span','workflow-mini-icon','◈'));
  const copy=el('div');append(copy,el('strong','',job.title||'Untitled workflow'),el('small','',compactId(job.job_id,22)));copy.lastChild.title=job.job_id||'';wrap.append(copy);return wrap;
}
function taskCountCell(job) {
  const running=Number(job.task_running||0), total=Number(job.task_total||0), completed=Number(job.task_completed||0), failed=Number(job.task_failed||0);
  const n=el('span','tasks-cell');n.append(document.createTextNode(`${completed}`),el('i','', '/'),document.createTextNode(`${total}`));
  if(running) n.append(el('i','',` · ${running} running`)); if(failed) n.append(el('i','',` · ${failed} failed`));return n;
}
function taskRoleLabel(task) {
  if (task?.role_display) return task.role_display;
  const custom = task?.custom_role || (task?.metadata && typeof task.metadata.custom_role_id === 'string' ? {
    name: task.metadata.custom_role_name || task.metadata.custom_role_id,
    role_id: task.metadata.custom_role_id,
    version: task.metadata.custom_role_version
  } : null);
  return custom ? `${custom.name || custom.role_id} (${custom.role_id}@${custom.version ?? '?'})` : (task?.role || 'unknown role');
}
function renderRecentJobs(items) {
  const body=$('recent-jobs');clear(body);
  if(!items?.length){const tr=el('tr');const td=el('td','table-empty','No workflows found in the local database.');td.colSpan=5;tr.append(td);body.append(tr);return;}
  for(const j of items.slice(0,7)){const tr=el('tr');tr.tabIndex=0;tr.setAttribute('aria-label',`Inspect workflow ${j.title}`);tr.addEventListener('click',()=>openJob(j.job_id));tr.addEventListener('keydown',e=>{if(e.key==='Enter')openJob(j.job_id)});append(tr,el('td','',undefined),el('td'),el('td'),el('td'),el('td','',undefined));tr.children[0].append(workflowCell(j));tr.children[1].append(el('span','phase-label',String(j.phase||j.state||'—').replaceAll('_',' ')));tr.children[2].append(taskCountCell(j));tr.children[3].append(pill(j.status));tr.children[4].append(relativeTime(j.updated_at));body.append(tr);}
}
function renderStatusBreakdown(o) {
  const target=$('status-breakdown');clear(target);
  const statuses=[['Active',getJobStatusCount(o,'active')],['Completed',getJobStatusCount(o,'completed')],['Failed',getJobStatusCount(o,'failed')]];
  for(const [name,count] of statuses){const item=el('div','breakdown-item');append(item,el('strong','',fmtNumber(count)),el('span','',name));target.append(item);}
}
function renderPhaseBars(phases) {
  const target=$('phase-bars');clear(target); const list=(phases||[]).slice(0,5);const max=Math.max(1,...list.map(x=>Number(x.count||0)));
  if(!list.length){target.append(el('div','muted','No runtime phases recorded.'));return;}
  for(const p of list){const row=el('div','phase-bar-row');const label=el('label','',String(p.name||'unknown').replaceAll('_',' ').toLowerCase());label.title=p.name||'';const track=el('div','phase-track');const fill=el('div','phase-fill');fill.style.width=`${Math.max(3,100*Number(p.count||0)/max)}%`;track.append(fill);append(row,label,track,el('b','',fmtNumber(p.count)));target.append(row);}
}
function eventIcon(type) {const t=String(type||'').toLowerCase();if(/fail|error|reject|block|timeout/.test(t))return ['!','red'];if(/artifact|result|report|review/.test(t))return ['▧','violet'];if(/approval|dispatch|start|complete|phase|task/.test(t))return ['↗',''];if(/security|access|intervention/.test(t))return ['⌑','amber'];return ['≋',''];}
function renderEventRow(evt, compact=false) {
  const [glyph,color]=eventIcon(evt.type);const row=el('div',compact?'event-row':'stream-event');if(!compact){row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`Inspect event ${evt.type||'event'}`);}
  const icon=el('span',`event-icon ${color}`,glyph);const main=el('div',compact?'event-main':'stream-body');
  append(main,el('div',compact?'event-title':'stream-event-head',undefined));
  if(compact){main.firstChild.textContent=evt.type||'event';const sub=el('div','event-sub');append(sub,el('code','',compactId(evt.job_id,18)),el('span','',ago(evt.created_at)));main.append(sub);row.append(icon,main,el('time','event-time',ago(evt.created_at)));}
  else {const head=main.firstChild;head.append(el('strong','',evt.type||'event'),el('time','',dateTime(evt.created_at)));const meta=el('div','stream-event-meta');append(meta,el('span','', 'JOB'),el('code','',compactId(evt.job_id,20)),el('span','',`ID ${compactId(evt.event_id,17)}`));main.append(meta);const rail=el('div','stream-rail');rail.append(el('span'));rail.append(el('i'));append(row,rail,main);row.addEventListener('click',()=>inspectEvent(evt));row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspectEvent(evt)}});}
  return row;
}
function renderLatestEvents(events) {const target=$('latest-events');clear(target);if(!events?.length){target.append(el('div','table-empty','No events recorded yet.'));return;}for(const evt of events.slice(0,5))target.append(renderEventRow(evt,true));}
function renderInventory(counts) {
  const target=$('inventory-list');clear(target);const rows=[['Tasks','Completed task records','⌘',counts.tasks],['Results','Persisted role outputs','◉',counts.results],['Reports','Synthesis and review reports','▤',counts.reports],['Approvals','Explicit decisions','✓',counts.approvals]];
  for(const [name,desc,glyph,count] of rows){const row=el('div','inventory-row');append(row,el('span','inventory-glyph',glyph));const c=el('div','inventory-copy');append(c,el('strong','',name),el('span','',desc));append(row,c,el('strong','inventory-value',fmtNumber(count)));target.append(row);}
}
function renderAttentionList(filter=state.attentionFilter) {
  state.attentionFilter=filter;const target=$('attention-list');if(!target)return;clear(target);
  const jobs=state.attentionJobs||[];const seen=new Set();let candidates=[];
  if(filter==='failed')candidates=jobs.filter(isFailedJob);
  else if(filter==='stale')candidates=jobs.filter(j=>isStaleJob(j));
  else if(filter==='pinned')candidates=jobs.filter(j=>state.pinnedJobs.has(j.job_id));
  else candidates=jobs.filter(j=>isFailedJob(j)||isStaleJob(j)||state.pinnedJobs.has(j.job_id));
  candidates.sort((a,b)=>{
    const rank=j=>isFailedJob(j)?0:isStaleJob(j)?1:2;
    const d=rank(a)-rank(b);if(d)return d;
    return (Date.parse(b.updated_at||'')||0)-(Date.parse(a.updated_at||'')||0);
  });
  candidates=candidates.filter(j=>{if(!j.job_id||seen.has(j.job_id))return false;seen.add(j.job_id);return true;});
  const candidateCount=candidates.length;candidates=candidates.slice(0,6);
  $('attention-count').textContent=fmtNumber(candidateCount);
  const summary=$('attention-summary');if(summary)summary.textContent=candidateCount>candidates.length?`Showing ${candidates.length} of ${fmtNumber(candidateCount)}. `:'';
  document.querySelectorAll('[data-attention-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.attentionFilter===filter));
  if(!candidates.length){const empty=el('div','attention-empty',filter==='pinned'?'No pinned workflows in this tab yet.':filter==='failed'?'No failed workflows in the recent snapshot.':filter==='stale'?'No active workflows have been quiet for more than 15 minutes.':'All clear — no failures or quiet active workflows in the recent snapshot.');target.append(empty);return;}
  for(const job of candidates){
    const row=el('div',`attention-item${isFailedJob(job)?' needs-error':isStaleJob(job)?' needs-stale':''}`);row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`Inspect ${job.title||job.job_id}`);
    const marker=el('span',`attention-marker ${isFailedJob(job)?'error':isStaleJob(job)?'stale':'pinned'}`,isFailedJob(job)?'!':isStaleJob(job)?'◷':'★');
    const main=el('div','attention-main');append(main,el('strong','',job.title||'Untitled workflow'));
    const meta=el('div','attention-meta');append(meta,pill(job.status||job.state),el('span','',isFailedJob(job)?'Needs investigation':isStaleJob(job)?`Quiet ${ago(job.updated_at)}`:'Pinned for this session'),relativeTime(job.updated_at));main.append(meta);
    const actions=el('div','attention-actions');append(actions,copyButton(job.job_id,'Copy ID'),pinButton(job));append(row,marker,main,actions);
    row.addEventListener('click',()=>openJob(job.job_id));row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openJob(job.job_id);}});target.append(row);
  }
}
function renderOverview() {
  if(!state.overview)return;const o=state.overview, c=o.counts||{};
  setCountsText('metric-jobs',c.jobs);setCountsText('metric-active',getTaskStatusCount(o,'running'));setCountsText('metric-events',c.events);setCountsText('metric-artifacts',c.artifacts);
  $('metric-jobs-foot').textContent=`${fmtNumber(getJobStatusCount(o,'active'))} active · ${fmtNumber(getJobStatusCount(o,'failed'))} failed`;
  $('metric-active-foot').textContent=`${fmtNumber(getTaskStatusCount(o,'pending'))} queued · ${fmtNumber(getTaskStatusCount(o,'completed'))} completed`;
  $('metric-artifact-foot').textContent=`${fmtNumber(c.results)} results · ${fmtNumber(c.reports)} reports`;
  const agg=state.aggGraph, a=agg?.summary||{};
  $('overview-agg-nodes').textContent=agg?.available?fmtNumber(a.nodes):'—';
  $('overview-agg-edges').textContent=agg?.available?fmtNumber(a.edges):'—';
  $('overview-agg-reuse').textContent=agg?.available?fmtNumber(a.reused_nodes):'—';
  $('overview-agg-usable').textContent=agg?.available?fmtNumber(a.usable_for_planning):'—';
  $('nav-agg-count').textContent=agg?.available?fmtNumber(a.nodes):'—';
  updateSparks(o.activity);renderActivityChart(o.activity);renderStatusBreakdown(o);renderPhaseBars(o.phases);renderLatestEvents(o.recent_events);renderInventory(c);renderAttentionList();
  if(state.view==='overview')loadJobs(true).catch(()=>{});
}
const AGG_NODE_ORDER=['hypothesis','idea','capability','experiment','evidence','condition'];
const AGG_NODE_LABELS={hypothesis:'Hypothesis',idea:'Idea',capability:'Capability',experiment:'Experiment',evidence:'Evidence',condition:'Condition'};
const AGG_EDGE_LABELS={supports:'supports',tested_by:'tested by',enables:'enables',contradicts:'contradicts',alternative_to:'alternative to',recovers_to:'recovers to',depends_on:'depends on',requires_all:'requires all'};
const SVG_NS='http://www.w3.org/2000/svg';
function svgElement(tag,attrs={},text=''){
  const item=document.createElementNS(SVG_NS,tag);
  for(const [name,value] of Object.entries(attrs))item.setAttribute(name,String(value));
  if(text!==undefined&&text!==null)item.textContent=String(text);
  return item;
}
function setAggNotice(message,kind='info'){
  const target=$('agg-connection-note');if(!target)return;
  target.textContent=message;target.dataset.kind=kind;target.classList.toggle('hidden',!message);
}
function renderAggMetrics(data){
  const s=data?.summary||{},available=data?.available===true;
  for(const [id,value] of [['agg-metric-nodes',s.nodes],['agg-metric-edges',s.edges],['agg-metric-goals',s.goals],['agg-metric-reuse',s.reused_nodes],['agg-metric-usable',s.usable_for_planning]])$(id).textContent=available?fmtNumber(value):'—';
  $('agg-node-detail').textContent=available?`${fmtNumber(s.unverified_nodes)} current revisions unverified`:'Graph tables unavailable';
  $('agg-edge-detail').textContent=available?`${fmtNumber(s.filtered_edges)} relations visible after filters`:'No relation snapshot';
  $('agg-goal-detail').textContent=available?`${fmtNumber(s.goals)} distinct goal scopes`:'No goal scope snapshot';
  $('agg-reuse-detail').textContent=available?'Identity appears in multiple goal scopes':'Reuse cannot be assessed';
  $('agg-trust-detail').textContent=available?'No independent verifier currently registered':'Verification status unavailable';
  $('agg-trust-copy').textContent=available
    ? `${fmtNumber(s.unverified_nodes)} current nodes remain unverified. ${fmtNumber(s.usable_for_planning)} nodes are eligible for planning under the current runtime trust contract. The knowledge store exposes no independent verifier; provenance and hashes do not establish factual truth.`
    : 'The AGG knowledge tables are not available in this database snapshot. Start the runtime once to initialize the persisted store.';
  $('nav-agg-count').textContent=available?fmtNumber(s.nodes):'—';
  $('overview-agg-nodes').textContent=available?fmtNumber(s.nodes):'—';
  $('overview-agg-edges').textContent=available?fmtNumber(s.edges):'—';
  $('overview-agg-reuse').textContent=available?fmtNumber(s.reused_nodes):'—';
  $('overview-agg-usable').textContent=available?fmtNumber(s.usable_for_planning):'—';
}
async function loadAggGraph(quiet=false){
  try{
    state.aggGoal=$('agg-goal-filter').value;
    state.aggType=$('agg-type-filter').value;
    state.aggSearch=$('agg-search').value.trim();
    state.aggIncludeRecovery=$('agg-recovery-filter').checked;
    const params=new URLSearchParams();
    if(state.aggGoal)params.set('goalId',state.aggGoal);
    if(state.aggType)params.set('type',state.aggType);
    if(state.aggSearch)params.set('q',state.aggSearch);
    if(state.aggIncludeRecovery)params.set('recovery','1');
    const data=await api(`/api/agg/graph?${params}`);state.aggGraph=data;renderAggMetrics(data);
    const goalSelect=$('agg-goal-filter');
    if(!goalSelect.dataset.initialized){
      const selected=state.aggGoal;for(const goal of data.goals||[]){const option=el('option','',goal.id);option.value=goal.id;option.textContent=`${goal.id} · ${goal.node_count} nodes`;goalSelect.append(option);}
      goalSelect.dataset.initialized='true';goalSelect.value=selected;
    }
    if(!data.available){setAggNotice(data.reason||'AGG graph unavailable.','warning');}
    else if(data.truncated){setAggNotice(`Showing ${data.nodes.length} of ${fmtNumber(data.summary.filtered_nodes)} matching nodes. Narrow by goal, type or search to inspect remaining nodes.`,'warning');}
    else {setAggNotice(`Snapshot read at ${dateTime(data.generated_at)} · persisted records only · no writes performed.`,'info');}
    $('agg-graph-meta').textContent=data.available
      ? `${fmtNumber(data.nodes.length)} nodes · ${fmtNumber(data.edges.length)} visible relations${data.goal_filter?` · goal ${data.goal_filter}`:''}${data.filters?.include_recovery?' · recovery edges included':''}`
      : 'No persisted AGG graph could be read.';
    $('agg-visible-count').textContent=data.available?`${fmtNumber(data.nodes.length)} nodes shown · ${fmtNumber(data.edges.length)} relations shown`:'Graph unavailable';
    renderAggGraph(data);renderAggSignals(data);renderAggActivity(data);
    if(state.aggSelectedNode&&data.nodes.some(node=>node.id===state.aggSelectedNode)){
      const selectedRevision=Number.isSafeInteger(state.aggNodeDetail?.revision)?state.aggNodeDetail.revision:null;
      await loadAggNodeDetail(state.aggSelectedNode,true,selectedRevision);
    }else if(state.aggSelectedNode){state.aggSelectedNode=null;state.aggNodeDetail=null;renderAggInspector(null);}
    try { await loadAggRuns(true); }
    catch(error) { renderAggRunAvailability(`Planner telemetry could not be read: ${error.message}`,'error'); }
  }catch(error){setAggNotice(`Unable to read AGG graph: ${error.message}`,'error');if(!quiet)notify(`Unable to load AGG graph: ${error.message}`,true);}
}
function renderAggGraph(data){
  const host=$('agg-graph-canvas');clear(host);
  if(!data?.available){host.append(el('div','agg-empty',data?.reason||'AGG knowledge graph is not available in the current SQLite snapshot.'));return;}
  const sourceNodes=data.nodes||[],sourceEdges=data.edges||[];
  if(!sourceNodes.length){host.append(el('div','agg-empty',data.query||data.goal_filter||data.filters?.type?'No AGG nodes match the current filters.':'The persisted knowledge ledger has no knowledge nodes yet. Per-run input graphs are stored separately; select a run in Planner run history to inspect its graph above.'));$('agg-visible-count').textContent='0 nodes shown · 0 relations shown';return;}
  let nodes=sourceNodes,edges=sourceEdges;
  if(state.aggShowNeighborhood&&state.aggSelectedNode){const ids=new Set([state.aggSelectedNode]);for(const edge of sourceEdges)if(edge.from===state.aggSelectedNode||edge.to===state.aggSelectedNode){ids.add(edge.from);ids.add(edge.to);}nodes=sourceNodes.filter(node=>ids.has(node.id));edges=sourceEdges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to));}
  $('agg-visible-count').textContent=`${fmtNumber(nodes.length)} nodes shown · ${fmtNumber(edges.length)} relations shown${state.aggShowNeighborhood&&state.aggSelectedNode?' · selected node + 1-hop neighbors':''}`;
  const neighborhoodButton=$('agg-neighborhood-toggle');if(neighborhoodButton){neighborhoodButton.disabled=!state.aggSelectedNode;neighborhoodButton.textContent=state.aggShowNeighborhood?'Show full graph':'Focus neighbors';neighborhoodButton.setAttribute('aria-pressed',String(state.aggShowNeighborhood));}
  const utilityNote=$('agg-graph-utility-note');if(utilityNote){const selected=sourceNodes.find(node=>node.id===state.aggSelectedNode);utilityNote.textContent=state.aggShowNeighborhood&&selected?`Focused on ${selected.label||selected.id} and its direct neighbors.`:selected?`Selected: ${selected.label||selected.id}. Focus neighbors to reduce clutter.`:'Select a node to inspect its 1-hop neighborhood.';}
  const bucketOrder=state.aggShowNeighborhood&&state.aggSelectedNode?[...new Set(nodes.map(node=>node.type))]:[...AGG_NODE_ORDER];
  const buckets=new Map(bucketOrder.map(type=>[type,[]]));
  for(const n of nodes){if(!buckets.has(n.type))buckets.set(n.type,[]);buckets.get(n.type).push(n);}
  // Deterministic, variable-size layered layout. Sort within each type by connected
  // neighborhood to reduce edge crossings while preserving stable tie-breaks.
  const nodeById=new Map(nodes.map(node=>[node.id,node]));
  const degree=new Map(nodes.map(node=>[node.id,0]));
  for(const edge of edges){degree.set(edge.from,(degree.get(edge.from)||0)+1);degree.set(edge.to,(degree.get(edge.to)||0)+1);}
  for(const [type,items] of buckets){
    items.sort((a,b)=>(degree.get(b.id)||0)-(degree.get(a.id)||0)||String(a.label||a.stable_key||a.id).localeCompare(String(b.label||b.stable_key||b.id))||a.id.localeCompare(b.id));
  }
  const typeColumn=new Map([...buckets.keys()].map((type,index)=>[type,index]));
  const sameColumnEdgeCounts=new Map(),backwardEdgeCounts=new Map();
  for(const edge of edges){const from=nodeById.get(edge.from),to=nodeById.get(edge.to);if(!from||!to)continue;const a=typeColumn.get(from.type),b=typeColumn.get(to.type);if(a===b)sameColumnEdgeCounts.set(a,(sameColumnEdgeCounts.get(a)||0)+1);else if(a>b){const key=`${a}-${b}`;backwardEdgeCounts.set(key,(backwardEdgeCounts.get(key)||0)+1);}}
  const maxBackwardLanes=Math.max(0,...backwardEdgeCounts.values());
  const top=76+maxBackwardLanes*9,left=28,rowGap=24,minNodeWidth=224,maxNodeWidth=292,nodeHeight=76;
  const nodeWidthFor=node=>Math.max(minNodeWidth,Math.min(maxNodeWidth,Math.max(String(node.label||node.stable_key||node.id).length*5.9+26,224)));
  const columnWidths=[...buckets.values()].map(items=>Math.max(minNodeWidth,...items.map(nodeWidthFor)));
  const columnX=[],columnGaps=[];let nextX=left;
  columnWidths.forEach((columnWidth,index)=>{columnX[index]=nextX;const internalLaneSpace=(sameColumnEdgeCounts.get(index)||0)*7+36;const columnGap=Math.max(116,internalLaneSpace);columnGaps[index]=columnGap;nextX+=columnWidth+columnGap;});
  const positions=new Map();let maxBottom=top;
  [...buckets.entries()].forEach(([type,items],column)=>{
    items.forEach((item,index)=>{
      const x=columnX[column],y=top+index*(nodeHeight+rowGap);
      positions.set(item.id,{x,y,w:nodeWidthFor(item),h:nodeHeight,node:item,column});
      maxBottom=Math.max(maxBottom,y+nodeHeight);
    });
  });
  const width=Math.max(760,columnX[columnX.length-1]+columnWidths[columnWidths.length-1]+columnGaps[columnGaps.length-1]+left);
  const height=Math.max(520,maxBottom+72);
  const svg=svgElement('svg',{viewBox:`0 0 ${width} ${height}`,role:'group','aria-label':'Interactive AGG knowledge graph. Use Tab to focus a node and Enter to inspect it.'});
  const defs=svgElement('defs');const marker=svgElement('marker',{id:'agg-arrow',viewBox:'0 0 10 10',refX:'8',refY:'5',markerWidth:'5',markerHeight:'5',orient:'auto-start-reverse'});marker.append(svgElement('path',{d:'M 0 0 L 10 5 L 0 10 z'}));defs.append(marker);svg.append(defs);
  [...buckets.entries()].forEach(([type,items],column)=>{
    const x=columnX[column];svg.append(svgElement('text',{x:x,y:30,class:'agg-svg-column-label'},AGG_NODE_LABELS[type]||type));
    svg.append(svgElement('text',{x:x,y:48,class:'agg-svg-column-count'},`${items.length} nodes`));
  });
  const connected=new Set(edges.flatMap(edge=>[edge.from,edge.to]));
  const orderedEdges=[...edges].sort((a,b)=>String(a.type).localeCompare(String(b.type))||String(a.id).localeCompare(String(b.id)));
  const sameColumnCounts=new Map(),backwardCounts=new Map();
  for(const edge of orderedEdges){
    const source=positions.get(edge.from),target=positions.get(edge.to);if(!source||!target)continue;
    const sy=source.y+source.h/2,ty=target.y+target.h/2;
    let d,labelX,labelY;
    if(source.column===target.column){
      const key=source.column;const lane=sameColumnCounts.get(key)||0;sameColumnCounts.set(key,lane+1);
      const laneX=columnX[key]+columnWidths[key]+18+lane*7;
      const sx=source.x+source.w,tx=target.x;
      d=`M ${sx} ${sy} L ${laneX} ${sy} L ${laneX} ${ty} L ${tx} ${ty}`;
      labelX=laneX+4;labelY=(sy+ty)/2-4;
    }else if(target.x>source.x){
      const sx=source.x+source.w,tx=target.x;const mid=(sx+tx)/2;
      d=`M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`;
      labelX=mid;labelY=(sy+ty)/2-5;
    }else{
      const key=`${source.column}-${target.column}`;const lane=backwardCounts.get(key)||0;backwardCounts.set(key,lane+1);
      const laneY=top-18-lane*9;const sx=source.x,tx=target.x+target.w;
      d=`M ${sx} ${sy} C ${sx-24} ${sy}, ${sx-24} ${laneY}, ${sx-24} ${laneY} L ${tx+24} ${laneY} C ${tx+24} ${laneY}, ${tx+24} ${ty}, ${tx} ${ty}`;
      labelX=(sx+tx)/2;labelY=laneY-3;
    }
    const path=svgElement('path',{d,class:`agg-edge agg-edge-${edge.type}`,'marker-end':'url(#agg-arrow)','data-edge-id':edge.id});
    const title=svgElement('title',{},`${edge.type}: ${source.node.label} to ${target.node.label} · ${edge.id}`);path.append(title);svg.append(path);
    if(Math.abs(source.y-target.y)>65||source.node.type===target.node.type||source.column>=target.column){
      const label=AGG_EDGE_LABELS[edge.type]||edge.type;
      const labelGroup=svgElement('g',{class:'agg-edge-label-group'});
      const labelWidth=Math.max(34,label.length*5.2+12);
      labelGroup.append(svgElement('rect',{x:labelX-labelWidth/2,y:labelY-10,width:labelWidth,height:14,rx:4,class:'agg-edge-label-bg'}));
      labelGroup.append(svgElement('text',{x:labelX,y:labelY,class:'agg-edge-label'},label));
      svg.append(labelGroup);
    }
  }
  for(const [id,point] of positions){
    const n=point.node;const selected=id===state.aggSelectedNode;
    const related=state.aggSelectedNode&&connected.has(id)&&edges.some(edge=>(edge.from===state.aggSelectedNode&&edge.to===id)||(edge.to===state.aggSelectedNode&&edge.from===id));
    const group=svgElement('g',{class:`agg-svg-node agg-type-${n.type}${selected?' selected':''}${related?' related':''}`,transform:`translate(${point.x} ${point.y})`,tabindex:'0',role:'button','aria-label':`Inspect ${AGG_NODE_LABELS[n.type]||n.type}: ${n.label}`, 'data-node-id':id});
    group.append(svgElement('rect',{width:point.w,height:point.h,rx:9}));
    group.append(svgElement('circle',{cx:14,cy:16,r:4}));
    group.append(svgElement('text',{x:25,y:19,class:'agg-svg-node-type'},(AGG_NODE_LABELS[n.type]||n.type).toUpperCase()));
    const label=String(n.label||n.stable_key||n.id);const labelText=svgElement('text',{x:11,y:39,class:'agg-svg-node-label'});
    const maxChars=Math.max(22,Math.floor((point.w-24)/6.1));
    const words=label.split(/\s+/);let line='',lines=[];
    for(const word of words){const candidate=line?`${line} ${word}`:word;if(candidate.length>maxChars&&line){lines.push(line);line=word;}else line=candidate;}
    if(line)lines.push(line);
    const visibleLines=lines.slice(0,2);if(lines.length>2)visibleLines[1]=`${visibleLines[1].slice(0,Math.max(1,maxChars-1))}…`;
    visibleLines.forEach((text,index)=>labelText.append(svgElement('tspan',{x:11,dy:index===0?0:13},text)));
    group.append(labelText);
    group.append(svgElement('text',{x:11,y:65,class:'agg-svg-node-meta'},`${n.status||'unverified'} · rev ${n.revision}`));
    const title=svgElement('title',{},`${n.label}\n${n.id}\nSHA-256 ${n.content_hash||'not recorded'}`);group.append(title);
    const inspect=()=>loadAggNodeDetail(id);
    group.addEventListener('click',inspect);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();inspect();}});svg.append(group);
  }
  svg.style.width=`${Math.round(width*state.aggZoom)}px`;svg.style.height=`${Math.round(height*state.aggZoom)}px`;
  host.append(svg);
}
async function loadAggNodeDetail(id,quiet=false,revision=null){
  state.aggSelectedNode=id;const neighborhoodButton=$('agg-neighborhood-toggle');if(neighborhoodButton)neighborhoodButton.disabled=false;const node=(state.aggGraph?.nodes||[]).find(item=>item.id===id);if(node){state.aggNodeDetail={...node};renderAggGraph(state.aggGraph);}
  const target=$('agg-node-inspector');clear(target);target.append(el('div','agg-empty','Loading exact node record, revision history and provenance…'));
  try{const suffix=revision===null?'':`?revision=${encodeURIComponent(revision)}`;const detail=await api(`/api/agg/nodes/${encodeURIComponent(id)}${suffix}`);state.aggNodeDetail=detail;renderAggInspector(detail);loadAggRelatedRunsForNode(id);}
  catch(error){renderAggInspector(node||null);if(!quiet)notify(`Unable to inspect AGG node: ${error.message}`,true);}
}
function renderAggInspector(data){
  const target=$('agg-node-inspector');clear(target);
  if(!data){$('agg-inspector-title').textContent='Node inspector';$('agg-inspector-subtitle').textContent='Select a graph node to trace it.';target.append(el('div','agg-empty','Select a node to inspect its revision, SHA-256, memberships, evidence references and provenance.'));return;}
  $('agg-inspector-title').textContent=data.label||data.stable_key||'AGG node';$('agg-inspector-subtitle').textContent=`${AGG_NODE_LABELS[data.type]||data.type} · revision ${data.revision}`;
  const header=el('div','agg-selected-state');append(header,pill(data.status||'unverified'),el('span','agg-unverified-label',data.usable_for_planning?'Planning eligible':'Not verified for planning'));target.append(header);
  const facts=el('dl','agg-node-facts');for(const [label,value] of [
    ['Node ID',data.id],['Stable key',data.stable_key],['Selected revision',data.revision],['Current revision',data.current_revision??data.revision],['Revision created',dateTime(data.created_at)],
    ['Revision history',data.revision_count??data.history?.length??0],['Evidence references',data.evidence_refs_count??data.evidence_count??0],['Goal memberships',data.memberships?.length||0]
  ]){facts.append(el('dt','',label),el('dd',label==='Node ID'||label==='Stable key'?'mono':'',value??'—'));}target.append(facts);
  if(data.content_hash)target.append(blockText(data.revision===data.current_revision?'CURRENT REVISION SHA-256':`REVISION ${data.revision} SHA-256`,data.content_hash),copyButton(data.content_hash,'Copy revision hash'));
  if(data.id)target.append(copyButton(data.id,'Copy node ID'));
  if(data.content!==undefined)target.append(blockText(`CONTENT${data.content_truncated?' · PREVIEW TRUNCATED':''}`,data.content));
  const refs=data.evidence_refs||[];const refSection=el('section','agg-inspector-section');append(refSection,el('h3','',`Evidence references · ${data.evidence_refs_count??refs.length}`));
  if(!refs.length)refSection.append(el('p','agg-muted','No evidence references recorded on this revision.'));else for(const ref of refs){
    const item=el('div','agg-ref-row');append(item,el('code','',ref));
    const actions=el('div','');actions.append(copyButton(ref,'Copy'));
    const findRuns=el('button','small-button','Find runs');findRuns.addEventListener('click',()=>{
      $('agg-run-search').value=ref;$('agg-run-status-filter').value='';$('agg-run-tool-filter').value='';$('agg-run-goal-filter').value='';$('agg-run-node-filter').value='';
      state.aggRunStatus='';state.aggRunTool='';state.aggRunGoal='';state.aggRunNode='';state.aggRunSince='';state.aggRunUntil='';state.aggRunOffset=0;
      loadAggRuns().then(()=>$('agg-run-dashboard').scrollIntoView({block:'start',behavior:'auto'})).catch(error=>renderAggRunAvailability(error.message,'error'));
    });actions.append(findRuns);item.append(actions);refSection.append(item);
  }
  if((data.evidence_refs_count||0)>refs.length)refSection.append(el('p','agg-muted',`Showing ${refs.length} of ${data.evidence_refs_count} references.`));target.append(refSection);
  const memberships=el('section','agg-inspector-section');memberships.append(el('h3','',`Goal memberships · ${(data.memberships||[]).length}`));
  if(!data.memberships?.length)memberships.append(el('p','agg-muted','No goal membership is available.'));
  for(const member of data.memberships||[]){const row=el('div','agg-ref-row');append(row,el('code','',member.goal_id),el('small','',dateTime(member.created_at)));const jump=el('button','small-button','Filter');jump.addEventListener('click',()=>{$('agg-goal-filter').value=member.goal_id;state.aggGoal=member.goal_id;loadAggGraph();});row.append(jump);memberships.append(row);}target.append(memberships);
  const provenance=data.provenance||{};const source=el('section','agg-inspector-section');source.append(el('h3','','Provenance'));source.append(makeTable(['FIELD','RECORDED VALUE'],[['Source',provenance.source||'—'],['Actor',provenance.actor||'—'],['Reference',provenance.reference||'—'],['Note',provenance.note||'—']]));target.append(source);
  const history=el('section','agg-inspector-section');history.append(el('h3','',`Revision history · ${(data.history||[]).length}`));
  if(!data.history?.length)history.append(el('p','agg-muted','No revision history returned.'));
  else for(const revision of data.history){const row=el('div',`agg-history-row${revision.revision===data.revision?' selected':''}`);append(row,el('strong','',`r${revision.revision}`),pill(revision.status),el('time','',dateTime(revision.created_at)));if(revision.content_hash){row.append(el('code','agg-history-hash',revision.content_hash));row.append(copyButton(revision.content_hash,'Copy hash'));}const inspect=el('button','small-button',revision.revision===data.revision?'Selected':'Inspect');inspect.disabled=revision.revision===data.revision;inspect.addEventListener('click',()=>loadAggNodeDetail(data.id,true,revision.revision));row.append(inspect);history.append(row);}target.append(history);
  const relations=el('section','agg-inspector-section');relations.append(el('h3','',`Relations · ${(data.relations||[]).length}`));
  if(!data.relations?.length)relations.append(el('p','agg-muted','No connected relation recorded.'));
  else for(const relation of data.relations){const row=el('div','agg-relation-row');append(row,el('strong','',AGG_EDGE_LABELS[relation.type]||relation.type),el('small','mono',`${compactId(relation.from,18)}  ·  ${compactId(relation.to,18)}`),el('small','',`Goal ${relation.goal_id} · ${dateTime(relation.created_at)}`));if(relation.provenance_hash)row.append(el('code','agg-history-hash',`Provenance SHA-256 ${relation.provenance_hash}`));const neighbour=relation.from===data.id?relation.to:relation.from;const inspect=el('button','small-button','Inspect linked node');inspect.addEventListener('click',()=>loadAggNodeDetail(neighbour));row.append(inspect);relations.append(row);}target.append(relations);
}
async function loadAggRelatedRunsForNode(nodeId){
  state.aggRelatedRunsNode=nodeId;
  try{
    const data=await api(`/api/agg/runs?nodeId=${encodeURIComponent(nodeId)}&limit=5&offset=0`);
    if(state.aggSelectedNode!==nodeId||state.aggRelatedRunsNode!==nodeId)return;
    const old=$('agg-node-related-runs');if(old)old.remove();
    const section=el('section','agg-inspector-section');section.id='agg-node-related-runs';section.append(el('h3','',`Planner run history · ${fmtNumber(data.total||0)}`));
    if(!data.available) section.append(el('p','agg-muted',data.reason||'Planner-run telemetry is not initialized.'));
    else if(!data.items?.length)section.append(el('p','agg-muted','No persisted planner invocation is linked to this node. This does not establish that the node was never used outside telemetry coverage.'));
    else for(const run of data.items){
      const row=el('div','agg-run-link-row');const copy=el('div','agg-run-link-copy');
      append(copy,el('strong','',run.tool_name.replace('adaptive_goal_','').replaceAll('_',' ')),el('small','',`${aggLifecycleLabel(run)} · ${run.algorithm_status||'algorithm outcome unknown'}`),el('small','',run.run_id));
      const action=el('button','small-button','Inspect run');action.addEventListener('click',()=>{
        state.aggRunOffset=0;state.aggRunNode=nodeId;$('agg-run-node-filter').value=nodeId;
        setView('agg');setAggRunUrl(run.run_id,nodeId);loadAggRunDetail(run.run_id);
        $('agg-run-dashboard').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      });
      append(row,copy,action);section.append(row);
    }
    if(data.total>(data.items||[]).length){const all=el('button','small-button',`Inspect all ${fmtNumber(data.total)} linked runs`);all.addEventListener('click',()=>{$('agg-run-node-filter').value=nodeId;state.aggRunNode=nodeId;state.aggRunOffset=0;loadAggRuns().then(()=>$('agg-run-dashboard').scrollIntoView({block:'start',behavior:'auto'}));});section.append(all);}
    $('agg-node-inspector').append(section);
  }catch(error){
    if(state.aggSelectedNode!==nodeId||state.aggRelatedRunsNode!==nodeId)return;
    const section=el('section','agg-inspector-section');section.id='agg-node-related-runs';section.append(el('h3','','Planner run history'),el('p','agg-muted',`Related run history unavailable: ${error.message}`));$('agg-node-inspector').append(section);
  }
}
function renderAggSignals(data){
  const target=$('agg-signal-list');clear(target);
  const s=data?.summary||{};
  const rows=[
    ['Knowledge capture',data?.available?`${fmtNumber(s.nodes)} nodes · ${fmtNumber(s.revisions)} revisions`:'Unavailable',data?.available?'Persisted store':'No graph schema'],
    ['Relationship coverage',data?.available?`${fmtNumber(s.edges)} relations`:'Unavailable',data?.available?'Typed links in current ledger':'No relation ledger'],
    ['Knowledge reuse',data?.available?`${fmtNumber(s.reused_nodes)} shared identities`:'Unavailable',data?.available?'Membership overlap only; no savings claim':'No reuse data'],
    ['Trust verification',data?.available?`${fmtNumber(s.unverified_nodes)} unverified · ${fmtNumber(s.usable_for_planning)} planning-eligible`:'Unavailable',data?.available?'Verifier path is not available in this store':'Trust state unknown'],
    ['Planner-run telemetry',data?.available?'Recorded separately':'Unavailable',data?.available?'Durable lifecycle, measured duration, observed steps, and linked evidence are available in Planner run history':'Telemetry schema has not been initialized by the writable runtime']
  ];
  for(const [name,value,detail] of rows){const row=el('div','agg-signal-row');append(row,el('div','agg-signal-name',name),el('strong','',value),el('small','',detail));target.append(row);}
}
function renderAggActivity(data){
  const target=$('agg-activity-list');clear(target);
  const activity=data?.activity||[];
  if(!data?.available){target.append(el('div','agg-empty','AGG ledger schema unavailable.'));return;}
  if(!activity.length){target.append(el('div','agg-empty','No node revisions or relation additions recorded yet.'));return;}
  for(const item of activity){const row=el('article','agg-activity-item');const marker=el('span',`agg-activity-mark ${item.kind==='edge_added'?'relation':'revision'}`,item.kind==='edge_added'?'↔':'◈');const body=el('div','agg-activity-copy');append(body,el('strong','',item.kind==='edge_added'?'Relation added':'Knowledge revision'),el('span','',item.detail||item.record_id),el('small','mono',item.goal_id?`Goal ${item.goal_id} · ${item.record_id}`:item.record_id));append(row,marker,body,el('time','',ago(item.created_at)));target.append(row);}
}
function formatAggDuration(value){
  if(!Number.isSafeInteger(value)||value<0)return 'Not observed';
  if(value<1000)return `${value} ms`;
  if(value<60000)return `${(value/1000).toFixed(value<10000?2:1)} s`;
  const minutes=Math.floor(value/60000),seconds=Math.floor((value%60000)/1000);
  return `${minutes}m ${seconds}s`;
}
function aggLifecycleLabel(run){
  if(run?.run_state==='possibly_interrupted')return 'Possibly interrupted';
  if(run?.run_state==='non_terminal'||run?.status==='running')return 'Non-terminal';
  return ({completed:'Tool completed',failed:'Tool error',running:'Running'}[run?.status]||'Unknown lifecycle');
}
function renderAggRunAvailability(message,kind='info'){
  const target=$('agg-run-availability');if(!target)return;
  target.textContent=message;target.dataset.kind=kind;target.classList.toggle('hidden',!message);
}
async function loadAggRuns(quiet=false){
  state.aggRunQuery=$('agg-run-search').value.trim();state.aggRunStatus=$('agg-run-status-filter').value;state.aggRunTool=$('agg-run-tool-filter').value;
  state.aggRunGoal=$('agg-run-goal-filter').value;state.aggRunNode=$('agg-run-node-filter').value.trim();
  const params=new URLSearchParams({limit:String(state.aggRunLimit),offset:String(state.aggRunOffset)});
  if(state.aggRunQuery)params.set('q',state.aggRunQuery);
  if(state.aggRunStatus)params.set('status',state.aggRunStatus);
  if(state.aggRunTool)params.set('tool',state.aggRunTool);
  if(state.aggRunGoal)params.set('goalId',state.aggRunGoal);
  if(state.aggRunNode)params.set('nodeId',state.aggRunNode);
  if(state.aggRunSince)params.set('since',state.aggRunSince);
  if(state.aggRunUntil)params.set('until',state.aggRunUntil);
  const data=await api(`/api/agg/runs?${params}`);state.aggRuns=data.items||[];state.aggRunTotal=Number(data.total||0);state.aggRunSummary=data.summary||null;
  renderAggRunSummary(data);renderAggRunTrend(data.trend||[],data.available);renderAggRunList(data);
  if(!data.available){renderAggRunAvailability(data.reason||'AGG planner telemetry is unavailable.','warning');}
  else if(!data.total){renderAggRunAvailability('Telemetry schema is available; no planner invocations match these filters. New runs appear after calling one of the enabled AGG search tools.','info');}
  else {renderAggRunAvailability(`Read-only SQLite snapshot at ${dateTime(data.generated_at)} · ${fmtNumber(data.total)} matching records${state.aggRunSince?` · UTC window ${state.aggRunSince} to ${state.aggRunUntil}`:''} · metrics are observations, not quality or acceptance signals.`,'info');}
  const urlRun=new URLSearchParams(window.location.search).get('run_id');
  const targetRun=state.aggRunSelected||urlRun||data.items?.[0]?.run_id||null;
  if(!state.aggRunSelected&&targetRun){state.aggRunSelected=targetRun;if(!urlRun)setAggRunUrl(targetRun);}
  if(targetRun&&(!state.aggRunDetail||state.aggRunDetail.run?.run_id!==targetRun)){
    if(data.available)await loadAggRunDetail(targetRun,true);
  }else if(targetRun&&state.aggRunDetail?.run?.run_id===targetRun){
    const selected=state.aggRuns.find(run=>run.run_id===targetRun);
    if(state.aggRunDetail.run.status==='running'||(selected&&selected.status!==state.aggRunDetail.run.status))await refreshAggRunDetail(targetRun);
  }else if(state.aggRunSelected&&!state.aggRunDetail){renderAggRunInspector(null);}
  renderAggRunQuickSelect(data.items||[]);
  return data;
}
function renderAggRunSummary(data){
  const s=data?.summary||{};
  for(const [id,value] of [['agg-run-total',s.total],['agg-run-completed',s.completed],['agg-run-failed',s.failed],['agg-run-unfinished',s.non_terminal]])$(id).textContent=data?.available?fmtNumber(value):'—';
  $('agg-run-average').textContent=data?.available&&s.average_duration_ms!==null&&s.average_duration_ms!==undefined?formatAggDuration(Number(s.average_duration_ms)):'—';
}
function renderAggRunTrend(days,available=true){
  const target=$('agg-run-trend');clear(target);
  if(!available){target.append(el('div','agg-empty','Durable planner telemetry has not been initialized by the writable runtime. No trend can be derived from the knowledge graph alone.'));return;}
  if(!state.aggRunSummary){target.append(el('div','agg-empty','Planner telemetry summary has not loaded.'));return;}
  if(!days.length||!days.some(day=>Number(day.runs)>0)){target.append(el('div','agg-empty','No planner invocations recorded in the last 14 days. This is an observed-history gap, not proof that no search was attempted outside telemetry coverage.'));return;}
  const max=Math.max(1,...days.map(day=>Number(day.runs)||0));
  for(const day of days){
    const total=Number(day.runs)||0,completed=Number(day.completed)||0,failed=Number(day.failed)||0,unfinished=Number(day.non_terminal)||0;
    const button=el('button','agg-run-trend-day');button.type='button';button.title=`${day.day}: ${total} recorded · ${completed} tool completed · ${failed} errors · ${unfinished} non-terminal`;
    button.setAttribute('aria-label',button.title);
    const stack=el('span','agg-run-trend-stack');const height=Math.max(total?3:0,Math.round(62*total/max));stack.style.height=`${height}px`;
    for(const [cls,value] of [['completed',completed],['failed',failed],['unfinished',unfinished]]){
      const segment=el('i',cls);const segmentHeight=total?Math.round(height*value/total):0;segment.style.setProperty('--segment-height',`${segmentHeight}px`);segment.title=`${value} ${cls}`;stack.append(segment);
    }
    button.append(stack,el('span','',day.day.slice(5)));button.addEventListener('click',()=>{
      $('agg-run-search').value='';$('agg-run-status-filter').value='';$('agg-run-tool-filter').value='';
      state.aggRunOffset=0;
      const from=`${day.day}T00:00:00.000Z`,to=`${day.day}T23:59:59.999Z`;
      // A date window is serialized separately from the full-day local chart label.
      state.aggRunSince=from;state.aggRunUntil=to;loadAggRunsForWindow(from,to);
    });
    target.append(button);
  }
}
async function loadAggRunsForWindow(since,until){
  try{
    state.aggRunQuery='';state.aggRunStatus='';state.aggRunTool='';state.aggRunOffset=0;
    state.aggRunSince=since;state.aggRunUntil=until;
    $('agg-run-search').value='';$('agg-run-status-filter').value='';$('agg-run-tool-filter').value='';
    await loadAggRuns();
  }catch(error){renderAggRunAvailability(`Unable to filter planner runs: ${error.message}`,'error');}
}
function renderAggRunQuickSelect(items){
  const select=$('agg-run-quick-select');if(!select)return;
  const list=Array.isArray(items)?items:[];const previous=state.aggRunSelected;clear(select);
  select.append(el('option','','Choose a recent run…'));select.firstChild.value='';
  for(const run of list){
    const when=run.started_at?dateTime(run.started_at):'Time unknown';
    const outcome=run.algorithm_status||run.status||'outcome unknown';
    const shape=`${fmtNumber(run.linked_node_count||0)}N/${fmtNumber(run.linked_edge_count||0)}E`;
    const option=el('option','',`${when} · ${outcome} · ${shape} · ${compactId(run.run_id,18)}`);option.value=run.run_id;select.append(option);
  }
  if(previous&&!list.some(run=>run.run_id===previous)){
    const option=el('option','',`Selected run · ${compactId(previous,24)}`);option.value=previous;select.append(option);
  }
  const selected=previous||list[0]?.run_id||'';select.value=selected;select.disabled=list.length===0&&!previous;
}

function renderAggRunList(data){
  const target=$('agg-run-list');clear(target);
  const items=data?.items||[];
  for(const run of items)if(run.goal_id)state.aggRunGoalOptions.add(run.goal_id);
  renderAggRunGoalOptions();
  $('agg-runs-meta').textContent=data?.available?`${fmtNumber(data.total)} matching invocations · newest start first${state.aggRunSince?' · date-filtered UTC window':''}`:'Telemetry is not initialized';
  $('agg-run-pagination-label').textContent=data?.total?`${state.aggRunOffset+1}–${state.aggRunOffset+items.length} of ${fmtNumber(data.total)}`:'0 runs';
  $('agg-run-newer').disabled=state.aggRunOffset===0;$('agg-run-older').disabled=!data?.has_more;
  if(!data?.available){target.append(el('div','agg-empty','The runtime has not created the telemetry schema. Start the updated MCP runtime once; Dashboard remains read-only and will not run migrations.'));return;}
  if(!items.length){target.append(el('div','agg-empty','No planner invocations match this filter. No mock history is inserted.'));return;}
  for(const run of items){
    const button=el('button',`agg-run-card${state.aggRunSelected===run.run_id?' selected':''}`);button.type='button';button.setAttribute('aria-pressed',String(state.aggRunSelected===run.run_id));
    button.setAttribute('aria-label',`Inspect AGG planner invocation ${run.run_id}, ${aggLifecycleLabel(run)}`);
    const main=el('div','agg-run-card-main');main.append(el('strong','',run.tool_name.replace('adaptive_goal_','').replaceAll('_',' ')),pill(run.run_state==='possibly_interrupted'?'possibly interrupted':run.status));
    const when=relativeTime(run.started_at);when.title=`Started ${dateTime(run.started_at)}`;
    const outcome=el('span','agg-run-card-outcome',run.algorithm_status?`Algorithm: ${run.algorithm_status.replaceAll('_',' ')}`:'Algorithm outcome not observed');
    const meta=el('div','agg-run-card-meta');
    append(meta,el('code','',compactId(run.run_id,24)),el('span','',`Duration ${run.terminal_observed?formatAggDuration(run.duration_ms):`provisional ${formatAggDuration(run.elapsed_ms)}`}`),el('span','',`${fmtNumber(run.observed_step_count||0)} observed steps`),el('span','',`${fmtNumber(run.linked_node_count||0)} linked nodes`));
    if(run.goal_id)meta.append(el('span','',`Goal ${compactId(run.goal_id,24)}`));
    button.append(main,when,outcome,meta);button.addEventListener('click',()=>loadAggRunDetail(run.run_id));target.append(button);
  }
}
function renderAggRunGoalOptions(){
  const select=$('agg-run-goal-filter');if(!select)return;const selected=state.aggRunGoal||select.value;clear(select);select.append(el('option','','All linked goals'));select.firstChild.value='';
  for(const goalId of [...state.aggRunGoalOptions].sort((a,b)=>a.localeCompare(b))){const option=el('option','',goalId);option.value=goalId;select.append(option);}
  select.value=selected;
}
function setAggRunUrl(runId,nodeId=null,revision=null){
  try{
    const url=new URL(window.location.href);url.searchParams.set('view','agg');
    if(runId)url.searchParams.set('run_id',runId);else url.searchParams.delete('run_id');
    if(nodeId)url.searchParams.set('node_id',nodeId);else url.searchParams.delete('node_id');
    if(nodeId&&Number.isSafeInteger(Number(revision))&&Number(revision)>0)url.searchParams.set('revision',String(Number(revision)));else url.searchParams.delete('revision');
    window.history.replaceState(window.history.state,'',`${url.pathname}${url.search}${url.hash}`);
  }catch{}
}
async function loadAggRunDetail(runId,quiet=false){
  const currentParams=new URLSearchParams(window.location.search);
  const preserveNodeId=currentParams.get('run_id')===runId?currentParams.get('node_id'):null;
  const preservedRevision=Number(currentParams.get('revision'));
  state.aggRunSelected=runId;state.aggRunDetail=null;state.aggRunEvents=[];state.aggRunEventsMore=false;
  setAggRunUrl(runId,preserveNodeId,Number.isSafeInteger(preservedRevision)&&preservedRevision>0?preservedRevision:null);
  const body=$('agg-run-inspector-body');clear(body);body.append(el('div','agg-empty','Loading durable run record, linked graph and ordered events…'));
  try{
    const data=await api(`/api/agg/runs/${encodeURIComponent(runId)}`);state.aggRunDetail=data;state.aggRunEvents=data.events||[];
    state.aggRunEventsMore=Boolean(data.events_truncated_in_response);
    renderAggRunList({available:true,items:state.aggRuns,total:state.aggRunTotal,has_more:state.aggRunOffset+state.aggRuns.length<state.aggRunTotal});
    renderAggRunQuickSelect(state.aggRuns);renderAggRunGraphStage(data);renderAggRunInspector(data);
    const nodeId=new URLSearchParams(window.location.search).get('node_id');
    if(nodeId) {
      const revision=Number(new URLSearchParams(window.location.search).get('revision'));
      const selected=data.nodes.find(node=>node.node_id===nodeId);
      if(selected){state.aggRunGraphSelectedNode=nodeId;applyAggRunGraphControls();renderAggRunGraphNodeDetail(data,selected);}
      if(selected&&selected.source_kind==='persisted_knowledge')await openAggRunNode(selected,true,Number.isSafeInteger(revision)&&revision>0?revision:(selected.revision??null));
      // Caller-graph nodes are already summarized beside the graph; avoid an automatic page jump.
      else if(selected)renderAggRunGraphNodeDetail(data,selected);
      else renderAggRunAvailability(`Node ${nodeId} is not present in the bounded snapshot for run ${runId}. Check the snapshot count/truncation flags before assuming the node was not observed.`,'warning');
    }
    return data;
  }catch(error){renderAggRunGraphStage(null,error.message);renderAggRunInspector(null,error.message);if(!quiet)notify(`Unable to inspect AGG planner run: ${error.message}`,true);return null;}
}
async function refreshAggRunDetail(runId){
  if(state.aggRunDetailRefreshing)return;
  state.aggRunDetailRefreshing=true;
  const body=$('agg-run-inspector-body'),scrollTop=body.scrollTop,priorEvents=[...(state.aggRunEvents||[])];
  try{
    const data=await api(`/api/agg/runs/${encodeURIComponent(runId)}`);
    if(state.aggRunSelected!==runId)return;
    state.aggRunDetail=data;
    const eventMap=new Map(priorEvents.map(event=>[event.sequence,event]));
    for(const event of data.events||[])if(!eventMap.has(event.sequence))eventMap.set(event.sequence,event);
    state.aggRunEvents=[...eventMap.values()].sort((a,b)=>a.sequence-b.sequence);
    const latest=state.aggRunEvents.reduce((max,event)=>Math.max(max,Number(event.sequence)||0),0);
    state.aggRunEventsMore=latest<Number(data.counts?.events||0);
    renderAggRunGraphStage(data);renderAggRunInspector(data);
    body.scrollTop=scrollTop;
    if(state.aggRunEventsMore)await loadAggRunEvents();
    body.scrollTop=scrollTop;
  }catch(error){renderAggRunAvailability(`Live refresh of selected run failed: ${error.message}`,'error');}
  finally{state.aggRunDetailRefreshing=false;}
}
function appendAggRunMetricCards(target,metrics){
  const defs=[
    ['expansions','Expansions'],['generated_states','Generated states'],['expanded_states','Expanded states'],['pruned_states','Pruned states'],
    ['explored_depth','Explored depth'],['simulations','Simulations'],['work_units','Work units'],['candidate_count','Candidates returned'],
    ['partial_candidate_count','Partial candidates'],['audit_event_count','Audit events reported'],['audit_events_omitted','Audit events omitted']
  ];
  const grid=el('div','agg-run-metric-observations');let count=0;
  for(const [key,label] of defs){if(!Object.hasOwn(metrics||{},key))continue;const card=el('div','agg-run-metric-observation');append(card,el('span','',label),el('strong','',fmtNumber(metrics[key])));grid.append(card);count++;}
  if(!count)grid.append(el('p','agg-muted','No numeric search counters were returned by this implementation. Missing metrics remain unknown.'));
  target.append(grid);
}
function renderAggRunGraphSnapshot(data,target){
  const nodes=data?.nodes||[],allEdges=data?.edges||[];
  const section=el('section','agg-run-detail-section agg-run-graph-section');
  section.append(el('h4','',`Input flow · ${fmtNumber(data?.counts?.nodes??nodes.length)} nodes · ${fmtNumber(data?.counts?.edges??allEdges.length)} relations`));
  section.append(el('p','agg-muted','Multi-row flowchart: follow green arrows left-to-right, then continue on the next row in reverse direction. Secondary relationships are hidden until enabled.'));
  if(!nodes.length){section.append(el('div','agg-empty','This run has no retained node snapshot to draw. Check the snapshot truncation flags and run metadata.'));target.append(section);return;}
  const maxNodes=100,maxEdges=250;
  const visibleNodes=nodes.slice(0,maxNodes),visibleIds=new Set(visibleNodes.map(node=>node.node_id));
  const edges=allEdges.filter(edge=>visibleIds.has(edge.from_node_id)&&visibleIds.has(edge.to_node_id)).slice(0,maxEdges);
  const notice=[];
  if(nodes.length>visibleNodes.length)notice.push(`showing ${visibleNodes.length} of ${nodes.length} nodes`);
  if(allEdges.filter(edge=>visibleIds.has(edge.from_node_id)&&visibleIds.has(edge.to_node_id)).length>edges.length)notice.push(`showing ${edges.length} relations within the visible node set`);
  if(notice.length)section.append(el('p','agg-run-graph-note',`Large graph snapshot: ${notice.join('; ')}.`));

  // Use only the ordered workflow relation to establish a stable sequence.
  // Other semantic relations must never distort the visual order of the main flow.
  const primaryEdges=edges.filter(edge=>edge.edge_type==='next_step');
  const ranks=new Map(),incoming=new Map(visibleNodes.map(node=>[node.node_id,0])),outgoing=new Map(visibleNodes.map(node=>[node.node_id,[]]));
  for(const edge of primaryEdges){if(!incoming.has(edge.from_node_id)||!incoming.has(edge.to_node_id))continue;incoming.set(edge.to_node_id,incoming.get(edge.to_node_id)+1);outgoing.get(edge.from_node_id).push(edge.to_node_id);}
  const queue=visibleNodes.filter(node=>incoming.get(node.node_id)===0).map(node=>node.node_id);
  for(const id of queue)ranks.set(id,0);
  for(let cursor=0;cursor<queue.length;cursor++){
    const from=queue[cursor];
    for(const to of outgoing.get(from)||[]){ranks.set(to,Math.max(ranks.get(to)||0,(ranks.get(from)||0)+1));incoming.set(to,incoming.get(to)-1);if(incoming.get(to)===0)queue.push(to);}
  }
  // Retain cyclic/disconnected nodes: attach them to the nearest ordered layer,
  // then place any isolated remainder in a final row rather than dropping nodes.
  const allNeighbors=new Map(visibleNodes.map(node=>[node.node_id,[]]));
  for(const edge of edges){if(!allNeighbors.has(edge.from_node_id)||!allNeighbors.has(edge.to_node_id))continue;allNeighbors.get(edge.from_node_id).push(edge.to_node_id);allNeighbors.get(edge.to_node_id).push(edge.from_node_id);}
  const fallback=[...ranks.keys()];
  if(!fallback.length&&visibleNodes.length){ranks.set(visibleNodes[0].node_id,0);fallback.push(visibleNodes[0].node_id);}
  for(let cursor=0;cursor<fallback.length;cursor++){const from=fallback[cursor];for(const to of allNeighbors.get(from)||[]){if(ranks.has(to))continue;ranks.set(to,(ranks.get(from)||0)+1);fallback.push(to);}}
  let unattachedRank=Math.max(-1,...ranks.values())+1;
  for(const node of visibleNodes)if(!ranks.has(node.node_id))ranks.set(node.node_id,unattachedRank++);

  const layers=new Map();
  for(const node of visibleNodes){const rank=ranks.get(node.node_id)||0;if(!layers.has(rank))layers.set(rank,[]);layers.get(rank).push(node);}
  const orderedRanks=[...layers.keys()].sort((a,b)=>a-b);
  for(const rank of orderedRanks)layers.get(rank).sort((a,b)=>String(a.node_id).localeCompare(String(b.node_id)));
  const colsPerRow=4,nodeWidth=224,columnGap=28,nodeGap=16,rowGap=50,leftBase=24;
  const wrapLabel=value=>{
    const maxChars=30,words=String(value).split(/\s+/);let line='',lines=[];
    for(const word of words){let remaining=word;if(remaining.length>maxChars){if(line){lines.push(line);line='';}while(remaining.length>maxChars){lines.push(remaining.slice(0,maxChars));remaining=remaining.slice(maxChars);}line=remaining;continue;}const candidate=line?`${line} ${remaining}`:remaining;if(candidate.length>maxChars&&line){lines.push(line);line=remaining;}else line=candidate;}
    if(line)lines.push(line);return lines.length?lines:['(no label)'];
  };
  const nodeLines=new Map(visibleNodes.map(node=>[node.node_id,wrapLabel(node.label||node.node_id)]));
  const nodeHeight=node=>Math.max(112,45+(nodeLines.get(node.node_id)?.length||1)*15+28);
  const layerStackHeight=rank=>layers.get(rank).reduce((sum,node)=>sum+nodeHeight(node),0)+Math.max(0,layers.get(rank).length-1)*nodeGap;
  const maxRank=Math.max(...orderedRanks),maxRow=Math.floor(maxRank/colsPerRow),contentWidth=colsPerRow*nodeWidth+(colsPerRow-1)*columnGap;
  const secondaryEdges=edges.filter(edge=>edge.edge_type!=='next_step');
  const longFlowEdges=edges.filter(edge=>edge.edge_type==='next_step'&&Math.abs((ranks.get(edge.to_node_id)??0)-(ranks.get(edge.from_node_id)??0))!==1);
  const laneEdgeCount=secondaryEdges.length+longFlowEdges.length;
  const leftMargin=28+Math.ceil(laneEdgeCount/2)*5,rightMargin=36+Math.ceil(laneEdgeCount/2)*5;
  const rowHeights=new Map();
  for(let row=0;row<=maxRow;row++){
    const ranksInRow=orderedRanks.filter(rank=>Math.floor(rank/colsPerRow)===row);
    rowHeights.set(row,28+Math.max(104,...ranksInRow.map(layerStackHeight)));
  }
  const rowY=new Map();let cursorY=44;
  for(let row=0;row<=maxRow;row++){rowY.set(row,cursorY);cursorY+=rowHeights.get(row)+rowGap;}
  const width=leftMargin+contentWidth+rightMargin,height=cursorY-rowGap+24,positions=new Map();
  for(const rank of orderedRanks){
    const row=Math.floor(rank/colsPerRow),slot=rank%colsPerRow,direction=row%2===0?1:-1,visualSlot=direction===1?slot:colsPerRow-1-slot;
    const stack=layers.get(rank),stackHeight=layerStackHeight(rank);let y=rowY.get(row)+28+(rowHeights.get(row)-28-stackHeight)/2;
    const x=leftMargin+visualSlot*(nodeWidth+columnGap);
    for(const node of stack){const h=nodeHeight(node);positions.set(node.node_id,{x,y,w:nodeWidth,h,node,rank,row,slot,visualSlot});y+=h+nodeGap;}
  }

  const svg=svgElement('svg',{viewBox:`0 0 ${width} ${height}`,role:'group','aria-label':'Multi-row planner flowchart. Follow next-step arrows across each row, then continue on the next row.'});
  const defs=svgElement('defs');
  const marker=svgElement('marker',{id:'agg-run-arrow',viewBox:'0 0 10 10',refX:'8',refY:'5',markerWidth:'5.5',markerHeight:'5.5',orient:'auto-start-reverse'});
  marker.append(svgElement('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#347b4e'}));defs.append(marker);
  const mutedMarker=svgElement('marker',{id:'agg-run-arrow-muted',viewBox:'0 0 10 10',refX:'8',refY:'5',markerWidth:'4.5',markerHeight:'4.5',orient:'auto-start-reverse'});
  mutedMarker.append(svgElement('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#929d95'}));defs.append(mutedMarker);svg.append(defs);

  // Draw quiet row bands and row-step captions so the eye always knows where to continue.
  for(let row=0;row<=maxRow;row++){
    const y=rowY.get(row),h=rowHeights.get(row),ranksInRow=orderedRanks.filter(rank=>Math.floor(rank/colsPerRow)===row);
    svg.append(svgElement('rect',{x:leftMargin-8,y:y-12,width:contentWidth+16,height:h+24,rx:12,fill:row%2===0?'#f7faf7':'#fbfcfb',stroke:'#edf2ee','stroke-width':1,class:'agg-run-row-band'}));
    const firstRank=ranksInRow[0]??row*colsPerRow,lastRank=ranksInRow[ranksInRow.length-1]??firstRank;
    svg.append(svgElement('text',{x:8,y:y+12,class:'agg-run-svg-row-caption'},`ROW ${String(row+1).padStart(2,'0')} · LAYERS ${firstRank+1}–${lastRank+1}`));
  }
  // Main-flow edges are drawn first and kept bold. Cross-row transitions run between aligned end/start slots.
  const auxiliaryLane={left:0,right:0};
  for(const edge of edges){
    const source=positions.get(edge.from_node_id),dest=positions.get(edge.to_node_id);if(!source||!dest)continue;
    const primary=edge.edge_type==='next_step',delta=dest.rank-source.rank;
    const sx=source.x+source.w/2,sy=source.y+source.h/2,tx=dest.x+dest.w/2,ty=dest.y+dest.h/2;
    let d;
    if(primary&&delta===1&&source.row===dest.row){
      const sourceRight=dest.x>source.x,ax=sourceRight?source.x+source.w:source.x,bx=sourceRight?dest.x:dest.x+dest.w,curve=(bx-ax)*.44;
      d=`M ${ax} ${sy} C ${ax+(sourceRight?curve:-curve)} ${sy}, ${bx-(sourceRight?curve:-curve)} ${ty}, ${bx} ${ty}`;
    }else if(primary&&delta===1&&source.row!==dest.row){
      const startX=source.x+source.w/2,startY=source.y+source.h,endX=dest.x+dest.w/2,endY=dest.y,mid=(startY+endY)/2;
      d=`M ${startX} ${startY} C ${startX} ${mid}, ${endX} ${mid}, ${endX} ${endY}`;
    }else{
      const goesLeft=dest.x+dest.w/2<source.x+source.w/2,lane=auxiliaryLane[goesLeft?'left':'right']++,laneX=goesLeft?leftMargin-18-lane*5:leftMargin+contentWidth+18+lane*5;
      const startX=goesLeft?source.x:source.x+source.w,endX=goesLeft?dest.x+dest.w:dest.x;
      d=`M ${startX} ${sy} L ${laneX} ${sy} L ${laneX} ${ty} L ${endX} ${ty}`;
    }
    const type=String(edge.edge_type||'relation'),path=svgElement('path',{d,class:`agg-run-svg-edge agg-run-edge-${type.replace(/[^a-z0-9_-]/gi,'-')}`,'marker-end':primary?'url(#agg-run-arrow)':'url(#agg-run-arrow-muted)','data-from-node':edge.from_node_id,'data-to-node':edge.to_node_id,'data-edge-type':type,'data-secondary':String(!primary)});
    path.append(svgElement('title',{},`${type}: ${source.node.label||source.node.node_id} → ${dest.node.label||dest.node.node_id}`));svg.append(path);
  }

  const nodeTypeColors={goal:'#477b56',task:'#647e9c',experiment:'#a67d37',hypothesis:'#7770a5',idea:'#4d8e80',candidate:'#aa6d55',capability:'#36847a',evidence:'#477fa3',condition:'#8b70a8'};
  for(const node of visibleNodes){
    const point=positions.get(node.node_id),type=String(node.node_type||'unknown').toLowerCase().replace(/[^a-z0-9_-]/g,'-'),color=nodeTypeColors[type]||'#728b7a';
    const group=svgElement('g',{class:'agg-run-svg-node',transform:`translate(${point.x} ${point.y})`,tabindex:'0',role:'button','aria-label':`Inspect input node ${node.label||node.node_id}`,'data-node-id':node.node_id,'data-node-type':type});
    group.append(svgElement('rect',{width:point.w,height:point.h,rx:9,style:`--run-node-color:${color}`}));
    group.append(svgElement('circle',{cx:13,cy:16,r:4,fill:color}));
    group.append(svgElement('text',{x:24,y:19,class:'agg-run-svg-type'},String(node.node_type||'unknown').toUpperCase()));
    const labelText=svgElement('text',{x:11,y:42,class:'agg-run-svg-label'}),lines=nodeLines.get(node.node_id)||[];
    lines.forEach((line,index)=>labelText.append(svgElement('tspan',{x:11,dy:index===0?0:15},line)));group.append(labelText);
    const idY=42+Math.max(0,lines.length-1)*15+25;
    const id=String(node.node_id||'');group.append(svgElement('text',{x:11,y:idY,class:'agg-run-svg-id'},id.length>37?`${id.slice(0,17)}…${id.slice(-17)}`:id));
    group.append(svgElement('title',{},`${node.label||node.node_id}\n${node.node_id}\n${node.source_kind||'source unknown'}`));
    const inspect=()=>{state.aggRunGraphSelectedNode=node.node_id;setAggRunUrl(data.run?.run_id||state.aggRunSelected,node.node_id,node.revision);applyAggRunGraphControls();renderAggRunGraphNodeDetail(data,node);};
    group.addEventListener('click',inspect);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();inspect();}});svg.append(group);
  }
  svg.dataset.baseWidth=String(width);svg.dataset.baseHeight=String(height);
  svg.style.width=`${width*state.aggRunGraphZoom/100}px`;svg.style.height=`${height*state.aggRunGraphZoom/100}px`;
  const scroll=el('div','agg-run-graph-scroll');scroll.append(svg);section.append(scroll);
  const legend=el('div','agg-run-graph-legend');
  for(const [type,color] of Object.entries(nodeTypeColors))if(visibleNodes.some(node=>String(node.node_type||'unknown').toLowerCase()===type)){
    const item=el('span','');item.style.setProperty('--run-node-color',color);item.append(el('i',''),el('span','',type));legend.append(item);
  }
  if(legend.childNodes.length)section.append(legend);
  const edgeLegend=el('div','agg-run-edge-legend');
  for(const [cls,label] of [['flow','Next step · main flow'],['secondary','Secondary relationships · hidden by default']]){const item=el('span',`agg-run-edge-key ${cls}`);item.append(el('i',''),el('span','',label));edgeLegend.append(item);}
  section.append(edgeLegend);
  target.append(section);
  applyAggRunGraphControls();
}
function renderAggRunGraphNodeDetail(data,node){
  const target=$('agg-run-graph-node-detail');if(!target)return;clear(target);
  if(!data||!node){target.classList.add('hidden');return;}
  target.classList.remove('hidden');
  const main=el('div','agg-run-node-detail-main');
  append(main,el('span','agg-run-node-detail-type',String(node.node_type||'unknown').replaceAll('_',' ')),el('strong','',node.label||node.node_id),el('code','',node.node_id));
  const actions=el('div','agg-run-node-detail-actions');
  if(node.source_kind==='persisted_knowledge'){const inspect=el('button','small-button','Open knowledge record');inspect.type='button';inspect.addEventListener('click',()=>openAggRunNode(node));actions.append(inspect);}
  const details=el('details','agg-run-node-snapshot-details');details.append(el('summary','',`Node snapshot · ${node.source_kind||'source unknown'}`));
  const snapshot=node.node_snapshot&&Object.keys(node.node_snapshot).length?node.node_snapshot:{node_id:node.node_id,node_type:node.node_type,label:node.label,source_kind:node.source_kind};
  details.append(el('pre','agg-run-event-payload',JSON.stringify(snapshot,null,2)));
  target.append(main,actions,details);
}

function renderAggRunGraphStage(data,errorMessage=null){
  const target=$('agg-run-graph-stage');if(!target)return;clear(target);
  const run=data?.run||null,nodes=data?.nodes||[];
  if(!run){
    state.aggRunGraphRunId=null;state.aggRunGraphSelectedNode=null;state.aggRunGraphSecondary=false;$('agg-run-graph-show-secondary').checked=false;renderAggRunGraphNodeDetail(null,null);
    $('agg-run-graph-stage-title').textContent='Planner run graph';
    $('agg-run-graph-stage-subtitle').textContent=errorMessage||'Choose a recorded run to explore its input graph, branches and convergence.';
    $('agg-run-graph-stage-facts').replaceChildren(el('span','agg-run-stage-fact','No run selected'));
    $('agg-run-graph-controls-status').textContent='Graph controls activate after a run is selected.';
    for(const id of ['agg-run-quick-select','agg-run-copy-link','agg-run-export-json','agg-run-export-svg','agg-run-graph-search','agg-run-graph-type-filter','agg-run-graph-clear','agg-run-graph-reset-view','agg-run-graph-zoom','agg-run-graph-show-secondary','agg-run-copy-node'])$(id).disabled=true;
    target.append(el('div','agg-empty',errorMessage||'Select a recorded planner invocation below to display its input graph.'));return;
  }
  if(state.aggRunGraphRunId!==run.run_id){
    state.aggRunGraphRunId=run.run_id;state.aggRunGraphQuery='';state.aggRunGraphType='';state.aggRunGraphZoom=100;state.aggRunGraphSelectedNode=null;state.aggRunGraphSecondary=false;renderAggRunGraphNodeDetail(null,null);
    $('agg-run-graph-search').value='';$('agg-run-graph-type-filter').value='';$('agg-run-graph-show-secondary').checked=false;$('agg-run-graph-zoom').value='100';$('agg-run-graph-zoom-value').textContent='100%';
  }
  $('agg-run-graph-stage-title').textContent=run.tool_name||'Planner run graph';
  $('agg-run-graph-stage-subtitle').textContent=`${aggLifecycleLabel(run)} · ${dateTime(run.started_at)} · run ${compactId(run.run_id,24)}`;
  const facts=$('agg-run-graph-stage-facts');clear(facts);
  for(const [label,value] of [['Nodes',data.counts?.nodes??nodes.length],['Edges',data.counts?.edges??(data.edges||[]).length],['Candidates',(data.candidates||[]).length],['Audit steps',run.search_event_count_recorded??data.counts?.steps??0],['Duration',run.terminal_observed?formatAggDuration(run.duration_ms):`provisional ${formatAggDuration(run.elapsed_ms)}`]]){
    const item=el('span','agg-run-stage-fact');append(item,el('small','',label),el('strong','',typeof value==='number'?fmtNumber(value):value));facts.append(item);
  }
  if(!nodes.length){
    $('agg-run-graph-controls-status').textContent='This run has no retained node snapshot.';
    target.append(el('div','agg-empty','No graph nodes were retained for this run. Inspect snapshot limit and telemetry capture details.'));
  } else renderAggRunGraphSnapshot(data,target);
  for(const id of ['agg-run-copy-link'])$(id).disabled=false;
  for(const id of ['agg-run-export-json','agg-run-export-svg','agg-run-graph-search','agg-run-graph-type-filter','agg-run-graph-clear','agg-run-graph-reset-view','agg-run-graph-zoom','agg-run-graph-show-secondary'])$(id).disabled=!nodes.length;
  $('agg-run-copy-node').disabled=!state.aggRunGraphSelectedNode;
}
function applyAggRunGraphControls({scrollToMatch=false}={}){
  const svg=$('agg-run-graph-stage')?.querySelector('svg');if(!svg)return;
  const query=String($('agg-run-graph-search')?.value||'').trim().toLocaleLowerCase();
  const type=String($('agg-run-graph-type-filter')?.value||'');
  const showSecondary=Boolean($('agg-run-graph-show-secondary')?.checked);state.aggRunGraphSecondary=showSecondary;
  state.aggRunGraphQuery=query;state.aggRunGraphType=type;
  const nodes=[...svg.querySelectorAll('.agg-run-svg-node')],nodeMap=new Map(nodes.map(node=>[node.dataset.nodeId,node]));
  let visible=0,matched=0;const matchIds=new Set();
  for(const node of nodes){
    const nodeType=node.dataset.nodeType||'';
    const text=`${node.querySelector('.agg-run-svg-label')?.textContent||''} ${node.dataset.nodeId||''}`.toLocaleLowerCase();
    const matches=!query||text.includes(query),showType=!type||nodeType===type;
    node.classList.toggle('agg-run-filtered',!showType);
    node.classList.toggle('agg-run-dimmed',Boolean(query&&!matches&&showType));
    node.classList.toggle('agg-run-match',Boolean(query&&matches&&showType));
    node.classList.toggle('agg-run-selected',node.dataset.nodeId===state.aggRunGraphSelectedNode);
    if(showType){visible++;if(query&&matches){matched++;matchIds.add(node.dataset.nodeId);}}
  }
  let visibleEdges=0;
  for(const edge of svg.querySelectorAll('.agg-run-svg-edge')){
    const from=nodeMap.get(edge.dataset.fromNode),to=nodeMap.get(edge.dataset.toNode);
    const show=Boolean(from&&to&&!from.classList.contains('agg-run-filtered')&&!to.classList.contains('agg-run-filtered')&&(showSecondary||edge.dataset.secondary!=='true'));
    edge.classList.toggle('agg-run-filtered',!show);
    edge.classList.toggle('agg-run-edge-dimmed',Boolean(query&&show&&!matchIds.has(edge.dataset.fromNode)&&!matchIds.has(edge.dataset.toNode)));
    if(show)visibleEdges++;
  }
  for(const label of svg.querySelectorAll('.agg-run-svg-edge-label-group,.agg-run-svg-edge-label')){const from=nodeMap.get(label.dataset.fromNode),to=nodeMap.get(label.dataset.toNode);const show=Boolean(from&&to&&!from.classList.contains('agg-run-filtered')&&!to.classList.contains('agg-run-filtered'));label.classList.toggle('agg-run-filtered',!show);label.classList.toggle('agg-run-edge-dimmed',Boolean(query&&show&&!matchIds.has(label.dataset.fromNode)&&!matchIds.has(label.dataset.toNode)));}
  $('agg-run-graph-controls-status').textContent=`Showing ${fmtNumber(visible)} of ${fmtNumber(nodes.length)} nodes${type?` · type: ${type}`:''}${query?` · ${fmtNumber(matched)} search match${matched===1?'':'es'}`:''} · ${fmtNumber(visibleEdges)} visible edges${showSecondary?' · secondary links on':' · secondary links hidden'}. Select a node to inspect its snapshot.`;
  const facts=$('agg-run-graph-stage-facts'),oldSelection=facts?.querySelector('.agg-run-stage-selected');if(oldSelection)oldSelection.remove();
  const chosen=state.aggRunDetail?.nodes?.find(item=>item.node_id===state.aggRunGraphSelectedNode);
  if(facts&&chosen){const item=el('span','agg-run-stage-selected');append(item,el('small','','Selected node'),el('strong','',chosen.label||chosen.node_id));facts.append(item);}
  $('agg-run-copy-node').disabled=!state.aggRunGraphSelectedNode;
  if(scrollToMatch){const targetNode=nodes.find(node=>node.classList.contains('agg-run-match'))||nodeMap.get(state.aggRunGraphSelectedNode);if(targetNode)targetNode.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});}
}
function setAggRunGraphZoom(value){
  const zoom=Math.max(50,Math.min(140,Number(value)||100));state.aggRunGraphZoom=zoom;$('agg-run-graph-zoom-value').textContent=`${zoom}%`;
  const svg=$('agg-run-graph-stage')?.querySelector('svg');if(!svg)return;
  const width=Number(svg.dataset.baseWidth),height=Number(svg.dataset.baseHeight);if(!Number.isFinite(width)||!Number.isFinite(height))return;
  svg.style.width=`${width*zoom/100}px`;svg.style.height=`${height*zoom/100}px`;
}
function downloadAggFile(content,mime,filename){
  try{const blob=new Blob([content],{type:mime}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=filename;link.style.display='none';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify(`Downloaded ${filename}`);return true;}
  catch(error){notify(`Download failed: ${error.message}`,true);return false;}
}
function exportAggRunJson(){
  const data=state.aggRunDetail;if(!data?.run)return notify('Select a run before exporting',true);
  const payload={schema_version:1,exported_at:new Date().toISOString(),run:data.run,graph_snapshot:{nodes:data.nodes||[],edges:data.edges||[],goals:data.goals||[],evidence:data.evidence||[]},counts:data.counts,metrics:data.metrics,candidates:data.candidates,provenance:data.provenance,trace_semantics:data.trace_semantics};
  downloadAggFile(JSON.stringify(payload,null,2),'application/json',`agg-run-${data.run.run_id}.json`);
}
function exportAggSvg(selector,filename){
  const source=document.querySelector(selector);if(!source)return notify('No graph is available to export',true);
  const clone=source.cloneNode(true);clone.setAttribute('xmlns',SVG_NS);
  const style=document.createElementNS(SVG_NS,'style');
  style.textContent='.agg-run-svg-edge{fill:none;stroke:#9baaa0;stroke-width:1.6;opacity:.7}.agg-run-edge-next_step{stroke:#347b4e;stroke-width:2.4;opacity:.95}.agg-run-edge-requires_all,.agg-run-edge-depends_on,.agg-run-edge-enables{stroke:#527b9b;stroke-width:2;stroke-dasharray:6 3}.agg-run-edge-supports{stroke:#638cae;stroke-dasharray:3 4}.agg-run-edge-tested_by{stroke:#ad8546;stroke-dasharray:4 3}.agg-run-edge-alternative_to{stroke:#8877a6;stroke-dasharray:6 4}.agg-run-edge-recovers_to{stroke:#bf8058;stroke-dasharray:2 4}.agg-run-svg-edge[data-secondary="true"]{stroke-width:1.6;opacity:.62}.agg-run-svg-node rect{fill:#fff;stroke:var(--run-node-color,#9bb29e);stroke-width:1.6}.agg-run-svg-type{fill:#526b58;font-size:10px;font-weight:750}.agg-run-svg-label{fill:#2d4134;font-size:12px;font-weight:650}.agg-run-svg-id{fill:#78877e;font-size:9px;font-family:monospace}.agg-run-svg-row-caption{fill:#829087;font:700 8px ui-sans-serif,system-ui,sans-serif;letter-spacing:.07em}.agg-run-filtered{display:none}.agg-run-dimmed{opacity:.17}.agg-run-edge-dimmed{opacity:.13}.agg-run-svg-node.agg-run-match rect{fill:#fff9df;stroke:#c79b37;stroke-width:2.6}.agg-run-svg-node.agg-run-selected rect{fill:#eef7ef;stroke:#2f7b48;stroke-width:3}.agg-edge{fill:none;stroke:#b9c8bc;stroke-width:1.45}.agg-svg-node rect{fill:#fff;stroke:#dbe5dd;stroke-width:1.2}.agg-svg-node text{fill:#43594a;font-size:10px}';
  clone.insertBefore(style,clone.firstChild);
  const box=(clone.getAttribute('viewBox')||'0 0 1200 700').split(/\s+/),width=Number(clone.dataset.baseWidth)||Number(box[2])||1200,height=Number(clone.dataset.baseHeight)||Number(box[3])||700;
  clone.setAttribute('width',String(width));clone.setAttribute('height',String(height));clone.style.width='';clone.style.height='';
  downloadAggFile(new XMLSerializer().serializeToString(clone),'image/svg+xml',filename);
}
function resetAggRunGraphControls(){
  state.aggRunGraphQuery='';state.aggRunGraphType='';state.aggRunGraphSelectedNode=null;renderAggRunGraphNodeDetail(null,null);
  $('agg-run-graph-search').value='';$('agg-run-graph-type-filter').value='';$('agg-run-graph-show-secondary').checked=false;$('agg-run-graph-zoom').value='100';setAggRunGraphZoom(100);setAggRunUrl(state.aggRunSelected);applyAggRunGraphControls();
  const scroll=$('agg-run-graph-stage')?.querySelector('.agg-run-graph-scroll');if(scroll){scroll.scrollLeft=0;scroll.scrollTop=0;}
}

function renderAggRunInspector(data,errorMessage=null){
  const target=$('agg-run-inspector-body');clear(target);
  if(!data){$('agg-run-inspector-title').textContent='Run inspector';$('agg-run-inspector-subtitle').textContent='Select a run to trace its observed lifecycle.';target.append(el('div','agg-empty',errorMessage||'No run selected. Select a recorded invocation to inspect its lifecycle, telemetry, graph snapshot and provenance.'));return;}
  const run=data.run||{};
  $('agg-run-inspector-title').textContent=run.tool_name||'AGG planner run';$('agg-run-inspector-subtitle').textContent=`${aggLifecycleLabel(run)} · started ${dateTime(run.started_at)}`;
  const head=el('div','agg-run-detail-head');append(head,pill(run.run_state==='possibly_interrupted'?'possibly interrupted':run.status),el('span','agg-run-id',run.run_id),copyButton(run.run_id,'Copy run ID'));target.append(head);
  const facts=el('dl','agg-run-detail-facts');
  for(const [label,value] of [
    ['Tool lifecycle',aggLifecycleLabel(run)],['Started',dateTime(run.started_at)],['Finished',run.terminal_observed?dateTime(run.finished_at):'No terminal record observed'],
    ['Recorded end-to-end duration',run.terminal_observed?formatAggDuration(run.duration_ms):`Provisional elapsed ${formatAggDuration(run.elapsed_ms)}`],
    ['Tool result observed after',run.tool_result_observed_duration_ms===null||run.tool_result_observed_duration_ms===undefined?'Not observed':formatAggDuration(run.tool_result_observed_duration_ms)],
    ['Algorithm outcome',run.algorithm_status||'Not observed'],['Termination reason',run.termination_reason||'Not observed'],
    ['Search run ID',run.search_run_id||'Not returned'],['Goal scope',run.goal_id||'None supplied'],['Goal node',run.goal_node_id||'None observed'],
    ['Graph hash',run.graph_hash||'Not returned'],['Input graph SHA-256',run.input_graph_sha256||'Not recorded'],
    ['Linked nodes / edges',`${fmtNumber(data.counts?.nodes||0)} / ${fmtNumber(data.counts?.edges||0)}`],
    ['Evidence references',fmtNumber(data.counts?.evidence||0)],['Observed search steps',`${fmtNumber(run.search_event_count_recorded||0)} recorded`],
    ['Omitted audit events',fmtNumber(run.search_event_count_omitted||0)]
  ])facts.append(el('dt','',label),el('dd',label==='Graph hash'||label==='Input graph SHA-256'||label==='Search run ID'||label==='Goal node'||label==='Goal scope'?'mono':'',value));
  target.append(facts);
  if(run.terminal_observed&&run.tool_result_observed_duration_ms!==null&&run.tool_result_observed_duration_ms!==undefined&&run.duration_ms>=run.tool_result_observed_duration_ms){
    const overhead=run.duration_ms-run.tool_result_observed_duration_ms;
    const note=el('p','agg-muted',`Terminal telemetry finalization after result observation: ${formatAggDuration(overhead)}. This is part of recorded end-to-end duration, not search-algorithm CPU time.`);target.append(note);
  }
  if(run.error){const error=el('div','agg-run-error');append(error,el('strong','',`${run.error.code||'Error'}${run.error.name?` · ${run.error.name}`:''}`),el('p','',run.error.message||'The tool failed without a recorded error message.'));target.append(error);}
  if(data.graph_snapshot_truncated||data.nodes_truncated_in_response||data.edges_truncated_in_response||data.evidence_truncated_in_response||data.events_truncated_in_response||run.search_events_truncated){
    const note=el('div','agg-run-error');
    const limits=data.snapshot_limits||{};
    note.textContent=`Trace is bounded or incomplete: ${[
      data.graph_snapshot_truncated?'graph snapshot exceeded storage bounds':null,
      data.nodes_truncated_in_response?'node list truncated by response limit':null,
      data.edges_truncated_in_response?'edge list truncated by response limit':null,
      data.evidence_truncated_in_response?'evidence list truncated by response limit':null,
      data.events_truncated_in_response?'timeline has more events':null,
      run.search_events_truncated?'search audit events omitted or capture failed':null
    ].filter(Boolean).join('; ')}. Limits: ${limits.graph_nodes_persisted_per_run??500} nodes, ${limits.graph_edges_persisted_per_run??2000} edges, ${limits.distinct_evidence_references_persisted_per_run??5000} evidence references. Missing links do not prove absence from the original run.`;
    target.append(note);
  }
  const metricsSection=el('section','agg-run-detail-section');metricsSection.append(el('h4','','Observed search metrics'));appendAggRunMetricCards(metricsSection,data.metrics||{});
  const secondaryMetrics=el('details','agg-run-event-copy');secondaryMetrics.append(el('summary','','All returned metric fields and implementation counters'),el('pre','agg-run-event-payload',JSON.stringify(data.metrics||{},null,2)));metricsSection.append(secondaryMetrics);target.append(metricsSection);
  const nodesSection=el('section','agg-run-detail-section');nodesSection.append(el('h4','',`Graph nodes · ${fmtNumber(data.counts?.nodes||0)}`));const nodeList=el('div','agg-run-link-list');
  for(const node of (data.nodes||[]).slice(0,80)){
    const row=el('div','agg-run-link-row');const copy=el('div','agg-run-link-copy');append(copy,el('strong','',node.label||node.node_id),el('small','',`${node.node_type||'unknown type'} · ${node.source_kind} · ${node.revision?`revision ${node.revision}`:'no persisted revision'}`),el('small','',node.node_id));
    if(node.content_hash)copy.append(el('small','',`Content SHA-256 ${node.content_hash}`));
    row.append(copy);const actions=el('div','');if(node.content_hash)actions.append(copyButton(node.content_hash,'Copy hash'));
    const inspect=el('button','small-button',node.source_kind==='persisted_knowledge'?'Inspect node':'Inspect snapshot');inspect.addEventListener('click',()=>{
      if(node.source_kind==='persisted_knowledge')openAggRunNode(node);
      else {const details=el('details','agg-run-event-copy');details.open=true;details.append(el('summary','',`Observed ${node.node_type||'node'} snapshot`));const pre=el('pre','agg-run-event-payload',JSON.stringify(node.node_snapshot,null,2));details.append(pre);row.after(details);}
    });actions.append(inspect);row.append(actions);nodeList.append(row);
  }
  if(!(data.nodes||[]).length)nodeList.append(el('p','', 'No graph node snapshot was available for this run.'));
  if(Number(data.counts?.nodes||0)>(data.nodes||[]).length)nodeList.append(el('p','agg-muted',`Showing ${(data.nodes||[]).length} of ${fmtNumber(data.counts.nodes)} linked nodes. API detail is bounded.`));
  nodesSection.append(nodeList);target.append(nodesSection);
  const edgeSection=el('section','agg-run-detail-section');edgeSection.append(el('h4','',`Graph edges · ${fmtNumber(data.counts?.edges||0)}`));
  const edgeList=el('div','agg-run-link-list');
  for(const edge of (data.edges||[]).slice(0,120)){
    const row=el('div','agg-run-link-row');const copy=el('div','agg-run-link-copy');
    append(copy,el('strong','',edge.edge_type||'Unknown relation'),el('small','',`${edge.source_kind} · ${edge.goal_id?`goal ${edge.goal_id}`:'goal not observed'}`),el('small','',`${edge.from_node_id}  /  ${edge.to_node_id}`));
    if(edge.edge_id)copy.append(el('small','',`Stored edge ID ${edge.edge_id}`));
    if(edge.evidence_refs?.length)copy.append(el('small','',`Declared edge evidence: ${edge.evidence_refs.join(', ')}`));
    const actions=el('div','');
    for(const [label,nodeId] of [['From',edge.from_node_id],['To',edge.to_node_id]]){
      const linkedNode=(data.nodes||[]).find(node=>node.node_id===nodeId);const button=el('button','small-button',`Inspect ${label.toLowerCase()}`);
      button.addEventListener('click',()=>linkedNode&&linkedNode.source_kind==='persisted_knowledge'?openAggRunNode(linkedNode):openAggRunNodeSnapshot(data,nodeId,{edge_type:edge.edge_type,edge_id:edge.edge_id}));actions.append(button);
    }
    row.append(copy,actions);edgeList.append(row);
  }
  if(!(data.edges||[]).length)edgeList.append(el('p','agg-muted','No edge snapshot was retained for this invocation.'));
  if(Number(data.counts?.edges||0)>(data.edges||[]).length)edgeList.append(el('p','agg-muted',`Showing ${(data.edges||[]).length} of ${fmtNumber(data.counts.edges)} linked edges. API detail is bounded.`));
  edgeSection.append(edgeList);target.append(edgeSection);
  const goalsSection=el('section','agg-run-detail-section');goalsSection.append(el('h4','',`Goal links · ${(data.goals||[]).length}`));
  for(const goal of data.goals||[]){
    state.aggRunGoalOptions.add(goal.goal_id);const row=el('div','agg-run-link-row');append(row,el('div','agg-run-link-copy',null),el('span','agg-muted',goal.goal_kind));
    row.firstChild.append(el('strong','',goal.goal_id),el('small','',`${goal.source_kind} · ${goal.goal_kind}`));const actions=el('div','');
    actions.append(copyButton(goal.goal_id,'Copy goal ID'));
    const filterGoal=el('button','small-button','Filter runs');filterGoal.addEventListener('click',()=>{state.aggRunGoal=goal.goal_id;$('agg-run-goal-filter').value=goal.goal_id;state.aggRunOffset=0;loadAggRuns().catch(error=>renderAggRunAvailability(error.message,'error'));});actions.append(filterGoal);
    const goalNode=(data.nodes||[]).find(node=>node.node_id===goal.goal_id);
    if(goalNode){const inspectGoal=el('button','small-button','Inspect goal');inspectGoal.addEventListener('click',()=>goalNode.source_kind==='persisted_knowledge'?openAggRunNode(goalNode):openAggRunNodeSnapshot(data,goalNode.node_id,{goal_id:goal.goal_id}));actions.append(inspectGoal);}
    row.append(actions);goalsSection.append(row);
  }
  renderAggRunGoalOptions();if(!data.goals?.length)goalsSection.append(el('p','agg-muted','No explicit goal scope was linked to this invocation.'));target.append(goalsSection);
  const evidenceSection=el('section','agg-run-detail-section');evidenceSection.append(el('h4','',`Evidence observations · ${fmtNumber(data.counts?.evidence||0)}`));const evidenceList=el('div','agg-run-link-list');
  for(const evidence of (data.evidence||[]).slice(0,80)){
    const row=el('div','agg-run-link-row');const copy=el('div','agg-run-link-copy');
    append(copy,el('strong','',evidence.reference),el('small','',`${evidence.observation_source} · ${evidence.kind||'kind not observed'} · ${evidence.classification||'classification not observed'}`));
    if(evidence.artifact_id)copy.append(el('small','',`Artifact ${evidence.artifact_id}${evidence.source_job_id?` · source job ${evidence.source_job_id}`:''}`));
    if(evidence.lineage_verified!==null)copy.append(el('small','',`Artifact lineage observed: ${evidence.lineage_verified?'true':'false'} · claim verified: ${evidence.claim_verified===null?'unknown':String(evidence.claim_verified)}`));
    const actions=el('div','');actions.append(copyButton(evidence.reference,'Copy reference'));
    const findRuns=el('button','small-button','Find runs');findRuns.addEventListener('click',()=>{
      $('agg-run-search').value=evidence.reference;$('agg-run-status-filter').value='';$('agg-run-tool-filter').value='';$('agg-run-goal-filter').value='';$('agg-run-node-filter').value='';
      state.aggRunStatus='';state.aggRunTool='';state.aggRunGoal='';state.aggRunNode='';state.aggRunSince='';state.aggRunUntil='';state.aggRunOffset=0;
      loadAggRuns().then(()=>$('agg-run-dashboard').scrollIntoView({block:'start',behavior:'auto'})).catch(error=>renderAggRunAvailability(error.message,'error'));
    });actions.append(findRuns);
    if(evidence.source_node_id){const sourceNode=(data.nodes||[]).find(node=>node.node_id===evidence.source_node_id);if(sourceNode){const inspect=el('button','small-button','Inspect source');inspect.addEventListener('click',()=>sourceNode.source_kind==='persisted_knowledge'?openAggRunNode(sourceNode):openAggRunNodeSnapshot(data,sourceNode.node_id,{evidence_reference:evidence.reference}));actions.append(inspect);}}
    if(evidence.artifact_id){const artifact=el('button','small-button','Open artifact');artifact.addEventListener('click',()=>{state.selectedArtifact=evidence.artifact_id;setView('artifacts');loadArtifacts().then(()=>inspectArtifact(evidence.artifact_id));});actions.append(artifact);}
    append(row,copy,actions);evidenceList.append(row);
  }
  if(!(data.evidence||[]).length)evidenceList.append(el('p','agg-muted','No evidence references were declared or resolved for this run.'));
  if(Number(data.counts?.evidence||0)>(data.evidence||[]).length)evidenceList.append(el('p','agg-muted','Evidence observation list truncated by API bounds.'));
  evidenceSection.append(evidenceList);target.append(evidenceSection);
  const candidateSection=el('section','agg-run-detail-section');candidateSection.append(el('h4','',`Returned candidates · ${(data.candidates||[]).length}`));
  if(!data.candidates?.length)candidateSection.append(el('p','agg-muted','The tool returned no candidate summary, or this was an early invocation failure.'));
  for(const candidate of data.candidates||[]){const box=el('details','agg-run-candidate');const summary=el('summary','',`${candidate.kind||'candidate'} · ${candidate.status||'status not observed'} · ${candidate.plan_id||'no ID'}`);box.append(summary);box.append(el('pre','agg-run-event-payload',JSON.stringify(candidate,null,2)));candidateSection.append(box);}target.append(candidateSection);
  const timeline=el('section','agg-run-detail-section');timeline.append(el('h4','',`Observed timeline · ${fmtNumber(data.counts?.events||0)} durable events`));
  const timelineList=el('div','agg-run-timeline');
  for(const event of state.aggRunEvents||data.events||[]){
    const entry=el('article','agg-run-event');entry.dataset.source=event.event_source;entry.dataset.type=event.event_type;
    const rail=el('span','agg-run-event-rail');rail.append(el('i'));const copy=el('div','agg-run-event-copy');
    const h=el('div','agg-run-event-head');append(h,el('strong','',`${event.sequence}. ${event.event_type.replaceAll('_',' ')}`),el('time','',dateTime(event.observed_at)),el('span','agg-muted',event.event_source));copy.append(h);
    const payload=event.payload||{};const nodeIds=new Set();
    for(const key of ['currentNodeId','fromNodeId','toNodeId','startNodeId','goalNodeId','nodeId'])if(typeof payload[key]==='string')nodeIds.add(payload[key]);
    for(const key of ['pathNodeIds','missingPrerequisiteNodeIds'])if(Array.isArray(payload[key]))for(const value of payload[key].slice(0,12))if(typeof value==='string')nodeIds.add(value);
    if(payload.conflictingEdge&&typeof payload.conflictingEdge==='object')for(const value of [payload.conflictingEdge.from,payload.conflictingEdge.to])if(typeof value==='string')nodeIds.add(value);
    if(nodeIds.size){const links=el('div','agg-run-event-node-links');for(const nodeId of [...nodeIds].slice(0,8)){const node=(data.nodes||[]).find(item=>item.node_id===nodeId);const button=el('button','small-button',`Node ${compactId(nodeId,17)}`);button.addEventListener('click',()=>node&&node.source_kind==='persisted_knowledge'?openAggRunNode(node):openAggRunNodeSnapshot(data,nodeId,payload));links.append(button);}copy.append(links);}
    const details=el('details');details.append(el('summary','',event.payload_truncated?'Payload preview (truncated)':'Payload details'),el('pre','agg-run-event-payload',JSON.stringify(payload,null,2)));copy.append(details);
    entry.append(rail,copy);timelineList.append(entry);
  }
  if(!(state.aggRunEvents||data.events||[]).length)timelineList.append(el('p','agg-muted','No lifecycle or search events were recorded for this invocation.'));
  timeline.append(timelineList);
  if(state.aggRunEventsMore){const more=el('button','small-button','Load more timeline events');more.addEventListener('click',loadAggRunEvents);timeline.append(more);}
  else if(data.events_truncated_in_response)timeline.append(el('p','agg-muted','More events exist, but timeline paging is unavailable.'));
  target.append(timeline);
  const provenanceSection=el('section','agg-run-detail-section');provenanceSection.append(el('h4','','Run provenance & limits'));provenanceSection.append(el('pre','agg-run-provenance',JSON.stringify(data.provenance||{},null,2)));provenanceSection.append(el('p','agg-muted',data.trace_semantics||'Metrics and outcomes describe the returned algorithm observations; they do not imply truth, acceptance, approval, dispatch or execution.'));provenanceSection.append(copyButton(JSON.stringify(data.provenance||{},null,2),'Copy provenance'));target.append(provenanceSection);
}
async function openAggRunNode(node,quiet=false,requestedRevision=null){
  const id=node?.node_id||node?.id;if(!id)return;
  state.aggSelectedRun=state.aggRunSelected;
  state.aggSelectedNode=id;
  const goalId=node.knowledge_goal_id||state.aggRunDetail?.run?.goal_id||'';
  if(goalId){state.aggGoal=goalId;$('agg-goal-filter').value=goalId;}
  state.aggType='';$('agg-type-filter').value='';state.aggSearch=id;$('agg-search').value=id;
  const revision=Number.isSafeInteger(Number(requestedRevision))&&Number(requestedRevision)>0?Number(requestedRevision):(node.revision??null);
  setAggRunUrl(state.aggRunSelected,id,revision);
  if(state.view!=='agg')setView('agg');
  await loadAggGraph(true);
  if((state.aggGraph?.nodes||[]).some(item=>item.id===id))await loadAggNodeDetail(id,true,revision);
  else {const text=`Node ${id} is linked to run ${state.aggRunSelected}, but is not present in the current knowledge-graph snapshot. Inspect the immutable run snapshot in this panel.`;if(!quiet)notify(text,true);}
}
function openAggRunNodeSnapshot(data,nodeId,payload){
  const found=(data.nodes||[]).find(node=>node.node_id===nodeId);
  const target=$('agg-run-inspector-body');const details=el('details','agg-run-event-copy');details.open=true;
  details.append(el('summary','',`Input graph node snapshot · ${nodeId}`));details.append(el('pre','agg-run-event-payload',JSON.stringify(found?.node_snapshot||{node_id:nodeId,observed_event_payload:payload},null,2)));
  target.append(details);details.scrollIntoView({block:'nearest',behavior:'auto'});
}
async function loadAggRunEvents(){
  const runId=state.aggRunSelected;if(!runId||state.aggRunEventsLoading)return;
  state.aggRunEventsLoading=true;
  try{
    const after=(state.aggRunEvents||[]).reduce((max,event)=>Math.max(max,Number(event.sequence)||0),0);
    const data=await api(`/api/agg/runs/${encodeURIComponent(runId)}/events?afterSequence=${after}&limit=100`);
    const seen=new Set((state.aggRunEvents||[]).map(event=>event.sequence));
    state.aggRunEvents.push(...(data.items||[]).filter(event=>!seen.has(event.sequence)));
    state.aggRunEventsMore=Boolean(data.has_more);
    if(state.aggRunDetail)renderAggRunInspector(state.aggRunDetail);
  }catch(error){notify(`Unable to load more AGG timeline events: ${error.message}`,true);}
  finally{state.aggRunEventsLoading=false;}
}
async function loadAttentionSnapshot() {
  const snapshot=await api('/api/jobs?limit=100&offset=0');
  const rows=snapshot.items||[];const known=new Set(rows.map(job=>job.job_id));
  const missing=[...state.pinnedJobs].filter(id=>!known.has(id)).slice(0,20);
  const pinned=await Promise.all(missing.map(async id=>{try{const detail=await api(`/api/jobs/${encodeURIComponent(id)}`);return detail.job||null;}catch{return null;}}));
  state.attentionJobs=[...rows,...pinned.filter(Boolean)];
}
async function refreshOverview() {
  try {
    const [health,overview]=await Promise.all([api('/api/health'),api('/api/overview')]);state.overview=overview;state.lastSync=new Date();
    if(state.view!=='agg'){
      try { state.aggGraph=await api('/api/agg/graph'); }
      catch(error) { state.aggGraph={available:false,reason:`AGG graph snapshot unavailable: ${error.message}`,summary:{}}; }
    }
    try { await loadAttentionSnapshot(); } catch {}
    $('top-health').textContent='Connected · read-only';$('runtime-status-title').textContent='Database connected';$('runtime-status-caption').textContent='Read-only SQLite';$('runtime-mode').textContent='LOCAL';$('runtime-mode').className='status-pill status-live';$('footer-clock').textContent=dateTime(state.lastSync.toISOString());$('last-updated').textContent=`UPDATED ${state.lastSync.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;$('last-updated').title=`Last successful refresh: ${dateTime(state.lastSync.toISOString())} · auto-refresh every 20s`;
    $('nav-jobs-count').textContent=fmtNumber(overview.counts?.jobs);$('nav-events-count').textContent=fmtNumber(overview.counts?.events);$('nav-roles-count').textContent=fmtNumber(overview.counts?.custom_profiles);$('nav-batches-count').textContent=fmtNumber(overview.counts?.batches);setBanner('');renderOverview();return true;
  } catch(error) {
    $('top-health').textContent='Disconnected';$('runtime-status-title').textContent='Local database unavailable';$('runtime-status-caption').textContent='Check plugin path and permissions';$('runtime-mode').textContent='OFFLINE';$('runtime-mode').className='status-pill status-failed';setBanner(`Cannot refresh the local database: ${error.message}. The last successful snapshot, if present, is retained.`);return false;
  }
}
function setViewPlaceholder(body, span, text) {clear(body);const tr=el('tr');const td=el('td','table-empty',text);td.colSpan=span;tr.append(td);body.append(tr);}
function renderJobsTable(items, body, onOpen, mode='all') {
  clear(body);if(mode==='all'){$('workflow-results-meta').textContent=`${fmtNumber(state.jobTotal)} workflows${state.jobQuery?' · search applied':''}${state.statusFilter?' · '+state.statusFilter:''}${state.phaseFilter?' · '+state.phaseFilter.replaceAll('_',' '):''}`;document.querySelectorAll('[data-quick-status]').forEach(b=>b.classList.toggle('selected',b.dataset.quickStatus===state.statusFilter));}if(!items?.length){const tr=el('tr'),td=el('td','table-empty','No matching workflows.');td.colSpan=mode==='all'?7:5;tr.append(td);body.append(tr);return;}
  for(const job of items){const tr=el('tr');tr.tabIndex=0;tr.setAttribute('aria-label',`Inspect workflow ${job.title||job.job_id}`);tr.addEventListener('click',()=>onOpen(job.job_id));tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen(job.job_id)}});
    if(mode==='all'){
      const td1=el('td');td1.append(workflowCell(job));
      const progress=el('div','progress-cell');const sum=el('div','progress-summary');append(sum,el('span','',`${job.task_completed||0} / ${job.task_total||0} complete`),el('b','',`${job.task_total?Math.round(100*job.task_completed/job.task_total):0}%`));const track=el('div','progress-track'),fill=el('i');fill.style.width=`${job.task_total?Math.round(100*job.task_completed/job.task_total):0}%`;track.append(fill);progress.append(sum,track);
      const statusTd=el('td');statusTd.append(pill(job.status));
      const phaseTd=el('td');phaseTd.append(el('span','phase-label',String(job.phase||job.state||'—').replaceAll('_',' ')));const progressTd=el('td');progressTd.append(progress);
      const actions=el('div','row-actions');append(actions,copyButton(job.job_id,'Copy ID'),pinButton(job));
      const eventsTd=el('td','',fmtNumber(job.event_total));const updatedTd=el('td');updatedTd.append(relativeTime(job.updated_at));const actionsTd=el('td');actionsTd.append(actions);
      append(tr,td1,statusTd,phaseTd,progressTd,eventsTd,updatedTd,actionsTd);
    }else{const td=el('td');td.append(workflowCell(job));const phaseTd=el('td');phaseTd.append(el('span','phase-label',String(job.phase||job.state||'—').replaceAll('_',' ')));const tasksTd=el('td');tasksTd.append(taskCountCell(job));const statusTd=el('td');statusTd.append(pill(job.status));append(tr,td,phaseTd,tasksTd,statusTd,el('td','',ago(job.updated_at)));}
    body.append(tr);
  }
}
function renderPagination(targetId,{total,offset,limit,onPrev,onNext}) {
  const target=$(targetId);clear(target);append(target,el('span','',`${total?offset+1:0}–${Math.min(total,offset+limit)} of ${fmtNumber(total)} records`));const actions=el('div');const prev=el('button','','← Previous');prev.disabled=offset<=0;prev.addEventListener('click',onPrev);const next=el('button','','Next →');next.disabled=offset+limit>=total;next.style.marginLeft='7px';next.addEventListener('click',onNext);append(actions,prev,next);target.append(actions);
}
async function loadJobs(quiet=false) {
  try{const overviewMode=state.view==='overview';const params=new URLSearchParams({q:overviewMode?'':state.jobQuery,status:overviewMode?'':state.statusFilter,phase:overviewMode?'':state.phaseFilter,limit:String(overviewMode?7:state.jobLimit),offset:String(overviewMode?0:state.jobOffset)});const data=await api(`/api/jobs?${params}`);state.jobs=data.items||[];state.jobTotal=data.total||0;if(state.overview&&overviewMode)renderRecentJobs(state.jobs);if(state.view==='workflows'){
    renderJobsTable(state.jobs,$('all-jobs'),openJob,'all');renderPagination('jobs-pagination',{total:state.jobTotal,offset:state.jobOffset,limit:state.jobLimit,onPrev:()=>{state.jobOffset=Math.max(0,state.jobOffset-state.jobLimit);loadJobs()},onNext:()=>{state.jobOffset+=state.jobLimit;loadJobs()}});
    const select=$('workflow-phase-filter');const prior=state.phaseFilter||select.value;const phases=[...new Set((state.overview?.phases||[]).map(p=>p.name).filter(Boolean))];clear(select);select.append(el('option','','All phases'));select.firstChild.value='';for(const p of phases){const opt=el('option','',p.replaceAll('_',' '));opt.value=p;select.append(opt)}select.value=phases.includes(prior)?prior:'';state.phaseFilter=select.value;if(state.phaseFilter!==prior)saveSessionPrefs();
  }}catch(error){if(!quiet)notify(`Unable to load workflows: ${error.message}`,true);}
}
async function openJob(jobId) {
  try{const data=await api(`/api/jobs/${encodeURIComponent(jobId)}`);setView('workflows');state.currentJob=data;state.jobTab='tasks';renderJobDetail();}catch(error){notify(`Unable to inspect job: ${error.message}`,true);}
}
function goBackToJobs(){state.currentJob=null;loadJobs();}
function makeFact(label,value){const box=el('div','panel');append(box,el('div','fact-label',label),el('div','fact-value',value));return box;}
function makeTable(headers, rows, emptyText='No records available.') {
  const wrap=el('div','table-wrap'),table=el('table','data-table'),thead=el('thead'),tr=el('tr');for(const h of headers)tr.append(el('th','',h));thead.append(tr);const tbody=el('tbody');
  if(!rows.length){const empty=el('tr'),td=el('td','table-empty',emptyText);td.colSpan=headers.length;empty.append(td);tbody.append(empty)}else for(const values of rows){const row=el('tr');for(const v of values){const td=el('td');if(v instanceof Node)td.append(v);else td.textContent=v==null?'—':String(v);row.append(td)}tbody.append(row)}table.append(thead,tbody);wrap.append(table);return wrap;
}
function blockText(label,value) {const box=el('details','payload-block');const summary=el('summary','payload-label',label);const pre=el('pre','payload-pre',typeof value==='string'?value:JSON.stringify(value,null,2));box.append(summary,pre);return box;}
function renderJobDetail() {
  const data=state.currentJob;if(!data)return;const job=data.job;
  const host=$('workflows-view');let detail=$('job-detail-shell');if(!detail){detail=el('div');detail.id='job-detail-shell';host.prepend(detail)}clear(detail);$('workflows-view').querySelector('.section-toolbar')?.classList.add('hidden');$('workflows-view').querySelector('.filter-rail')?.classList.add('hidden');$('workflows-view').querySelector('.table-panel')?.classList.add('hidden');
  const back=el('button','small-button job-detail-back','← Back to workflow registry');back.addEventListener('click',()=>{detail.remove();$('workflows-view').querySelector('.section-toolbar')?.classList.remove('hidden');$('workflows-view').querySelector('.filter-rail')?.classList.remove('hidden');$('workflows-view').querySelector('.table-panel')?.classList.remove('hidden');goBackToJobs()});detail.append(back);
  const header=el('div','job-detail-header'),left=el('div');append(left,el('h2','',job.title||'Untitled workflow'),el('p','mono',job.job_id),el('p','',`Created ${dateTime(job.created_at)} · Updated ${dateTime(job.updated_at)}`),copyButton(job.job_id,'Copy ID'),pinButton(job));append(header,left,pill(job.status));detail.append(header);
  const grid=el('div','job-detail-grid');append(grid,makeFact('RUNTIME PHASE',String(job.phase||job.state||'—').replaceAll('_',' ')),makeFact('TASKS',`${data.tasks.filter(t=>t.status==='completed').length} / ${data.tasks.length} completed`),makeFact('DURABLE EVENTS',fmtNumber(data.events.length)));detail.append(grid);
  const tabs=el('div','job-tabs');const counts={tasks:data.tasks.length,approvals:data.approvals.length,attempts:data.attempts.length,results:data.results.length,artifacts:data.artifacts.length,reports:data.reports.length,events:data.events.length,transitions:data.transitions.length,executions:data.batches.length};for(const tab of Object.keys(counts)){const b=el('button',`job-tab${state.jobTab===tab?' active':''}`,`${tab[0].toUpperCase()+tab.slice(1)} · ${counts[tab]}`);b.addEventListener('click',()=>{state.jobTab=tab;renderJobDetail()});tabs.append(b)}detail.append(tabs);
  const body=el('div','panel job-subpanel');
  if(state.jobTab==='tasks'){
    const rows=data.tasks.map(t=>[el('span','mono',compactId(t.task_id,20)),taskRoleLabel(t),pill(t.status),Array.isArray(t.dependency)?t.dependency.join(', '):boundedString(t.dependency_json),t.execution_exit_code==null?'—':String(t.execution_exit_code),ago(t.updated_at)]);body.append(makeTable(['TASK ID','ROLE / PROFILE','STATUS','DEPENDENCIES','EXIT','UPDATED'],rows));
    for(const t of data.tasks){const item=el('div','detail-list-item');append(item,el('strong','',`${taskRoleLabel(t)} · ${t.status}`),el('small','mono',t.task_id),el('p','',t.description||''));if(t.execution_stderr)item.append(blockText('STDERR',t.execution_stderr));if(t.execution_stdout)item.append(blockText('STDOUT',t.execution_stdout));body.append(item)}
  } else if(state.jobTab==='approvals') body.append(makeTable(['DECISION','ACTOR','TIMESTAMP','PLAN HASH','DETAIL'],data.approvals.map(a=>[pill(a.decision),a.actor, dateTime(a.created_at),compactId(a.proposal_hash,18),a.raw_text])));
  else if(state.jobTab==='attempts') body.append(makeTable(['ROLE / PROFILE','STATUS','STARTED','FINISHED','ERROR'],data.attempts.map(a=>[taskRoleLabel(data.tasks.find(t=>t.task_id===a.task_id)||{role:a.role}),pill(a.status),dateTime(a.started_at),dateTime(a.finished_at),a.error])));
  else if(state.jobTab==='results') for(const r of data.results){const item=el('div','detail-list-item');append(item,el('strong','',`${taskRoleLabel(data.tasks.find(t=>t.task_id===r.task_id)||{role:r.role})} · ${r.outcome}`),el('small','mono',r.result_id),el('small','',dateTime(r.created_at)),blockText('RESULT CONTENT',r.content));body.append(item)}
  else if(state.jobTab==='artifacts') for(const a of data.artifacts){const row=el('div','detail-list-item');append(row,el('strong','',`${a.type||'artifact'} · ${a.status||'unknown'}`),el('small','mono',a.artifact_id),el('small','',`Producer ${a.producer_role||'unknown'} · hash ${a.content_hash||'—'}`));const b=el('button','inspector-link','Inspect artifact');b.addEventListener('click',()=>{state.selectedArtifact=a.artifact_id;setView('artifacts');loadArtifacts().then(()=>inspectArtifact(a.artifact_id))});row.append(b);body.append(row)}
  else if(state.jobTab==='reports')for(const r of data.reports){const item=el('div','detail-list-item');append(item,el('strong','',r.kind||'report'),el('small','',dateTime(r.created_at)),blockText('REPORT CONTENT',r.content));body.append(item)}
  else if(state.jobTab==='events')for(const e of data.events)body.append(eventDetailCard(e));
  else if(state.jobTab==='transitions')body.append(makeTable(['FROM','TO','EVENT','ATTEMPT','TIME'],data.transitions.map(e=>[e.from_phase||'—',e.to_phase||'—',e.type||'—',e.attempt??'—',dateTime(e.created_at)])));
  else if(state.jobTab==='executions'){if(!data.batches.length)body.append(el('div','table-empty','No durable batch record exists for this workflow. Specialist roles run as individual tasks unless an authorized execute_batch call groups deterministic local tasks.'));for(const b of data.batches){const item=el('div','detail-list-item');append(item,el('strong','',`${b.role} · ${b.status}`),el('small','mono',b.batch_id),el('small','',`${b.items?.length||0} execution items · attempt ${b.attempt}`));if(b.aggregate_content)item.append(blockText('AGGREGATE OUTPUT',b.aggregate_content));for(const i of b.items||[]){append(item,el('p','mono',`$ ${i.command}`),el('small','',`status ${i.status} · exit ${i.exit_code??'—'} · cwd ${i.cwd||'—'}`));if(i.stdout)item.append(blockText('STDOUT',i.stdout));if(i.stderr)item.append(blockText('STDERR',i.stderr));if(i.error)item.append(blockText('ERROR',i.error))}body.append(item)}}
  detail.append(body);window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function boundedString(v){return typeof v==='string'?v:JSON.stringify(v??'—')}
function eventDetailCard(evt){const card=el('div','detail-list-item');append(card,el('strong','',evt.type||'event'),el('small','mono',evt.event_id||evt.workflow_event_id),el('small','',dateTime(evt.created_at)),blockText('PAYLOAD',evt.payload));return card}
async function loadEvents() {
  try{const q=$('event-search').value;state.eventQuery=q;state.eventType=$('event-type-filter').value;const params=new URLSearchParams({q,type:state.eventType,limit:String(state.eventLimit),offset:String(state.eventOffset)});const data=await api(`/api/events?${params}`);state.events=data.items||[];state.eventTotal=data.total||0;$('event-total').textContent=`${fmtNumber(data.total)} records`;const target=$('event-stream');clear(target);if(!state.events.length)target.append(el('div','table-empty','No events match these filters.'));else for(const e of state.events)target.append(renderEventRow(e,false));renderPagination('events-pagination',{total:state.eventTotal,offset:state.eventOffset,limit:state.eventLimit,onPrev:()=>{state.eventOffset=Math.max(0,state.eventOffset-state.eventLimit);loadEvents()},onNext:()=>{state.eventOffset+=state.eventLimit;loadEvents()}});
    const typeSel=$('event-type-filter'),prior=typeSel.value;if(typeSel.options.length<=1){const types=[...new Set(state.events.map(e=>e.type).filter(Boolean))];for(const t of types){const opt=el('option','',t);opt.value=t;typeSel.append(opt)}typeSel.value=prior;}
  }catch(error){notify(`Unable to load events: ${error.message}`,true)}
}
function inspectEvent(evt) {
  state.selectedEvent=evt;const target=$('event-inspector');clear(target);target.className='';append(target,el('div','detail-fact',`Event ID: ${evt.event_id||evt.workflow_event_id}`),el('div','detail-fact',`Job: ${evt.job_id}`),el('div','detail-fact',`Time: ${dateTime(evt.created_at)}`),copyButton(evt.event_id||evt.workflow_event_id,'Copy event ID'),copyButton(evt.job_id,'Copy job ID'),blockText('EVENT TYPE',evt.type),blockText('PAYLOAD',evt.payload));const button=el('button','inspector-link','Open source workflow');button.addEventListener('click',()=>openJob(evt.job_id));target.append(button);
}
async function loadArtifacts() {
  try{state.artifactQuery=$('artifact-search').value;state.artifactType=$('artifact-type-filter').value;const params=new URLSearchParams({q:state.artifactQuery,type:state.artifactType,limit:String(state.artifactLimit),offset:String(state.artifactOffset)});const data=await api(`/api/artifacts?${params}`);state.artifacts=data.items||[];state.artifactTotal=data.total||0;const grid=$('artifact-grid');clear(grid);if(!state.artifacts.length)grid.append(el('div','table-empty','No artifacts match this filter.'));for(const a of state.artifacts){const b=el('button',`artifact-card${state.selectedArtifact===a.artifact_id?' selected':''}`);const head=el('div','artifact-card-head');append(head,el('span','artifact-glyph','▧'));const title=el('div','artifact-card-title');append(title,el('strong','',a.type||'Artifact'),el('small','',`${a.producer_role||'unknown producer'} · schema ${a.schema_version??'—'}`));head.append(title);b.append(head,el('p','mono',compactId(a.artifact_id,30)));const foot=el('div','artifact-card-foot');foot.append(pill(a.status||'unknown'),el('span','hash-short',a.content_hash?`${a.content_hash.slice(0,10)}…`:'no hash'));b.append(foot);b.addEventListener('click',()=>inspectArtifact(a.artifact_id));grid.append(b)}renderPagination('artifacts-pagination',{total:state.artifactTotal,offset:state.artifactOffset,limit:state.artifactLimit,onPrev:()=>{state.artifactOffset=Math.max(0,state.artifactOffset-state.artifactLimit);loadArtifacts()},onNext:()=>{state.artifactOffset+=state.artifactLimit;loadArtifacts()}});
    const typeSel=$('artifact-type-filter'),prior=typeSel.value;if(typeSel.options.length<=1){const types=[...new Set(state.artifacts.map(a=>a.type).filter(Boolean))];for(const t of types){const opt=el('option','',t);opt.value=t;typeSel.append(opt)}typeSel.value=prior;}
    if(state.selectedArtifact)await inspectArtifact(state.selectedArtifact,false);
  }catch(error){notify(`Unable to load artifacts: ${error.message}`,true)}
}
async function inspectArtifact(id, updateSelection=true) {
  try{const a=await api(`/api/artifacts/${encodeURIComponent(id)}`);if(updateSelection)state.selectedArtifact=id;const target=$('artifact-inspector-body');clear(target);target.className='';$('artifact-inspector-title').textContent=a.type||'Artifact';$('artifact-inspector-subtitle').textContent=`${a.producer_role||'Unknown producer'} · ${dateTime(a.created_at)}`;
    const facts=el('div','detail-facts');for(const [k,v] of [['STATUS',a.status],['SCHEMA',a.schema_version],['CONTENT SIZE',`${fmtNumber(a.content_length)} chars`],['HASH',a.content_hash?`${a.content_hash.slice(0,15)}…`:'not recorded']]){const box=el('div','detail-fact');append(box,el('span','',k),el('strong','',v??'—'));facts.append(box)}target.append(facts,copyButton(a.artifact_id,'Copy artifact ID'),blockText('ARTIFACT ID',a.artifact_id),blockText('JOB / TASK',`${a.job_id}\n${a.task_id||'no task id'}`),blockText('EVIDENCE REFERENCES',a.evidence??'Not recorded'),blockText('CONTENT',a.content_malformed?a.content_preview:a.content));if(a.content_truncated)target.append(el('div','danger-note','Content preview is truncated. Original content remains unchanged in the local SQLite store.'));const button=el('button','inspector-link','Open source workflow');button.addEventListener('click',()=>openJob(a.job_id));target.append(button);document.querySelectorAll('.artifact-card').forEach(c=>c.classList.toggle('selected',c.querySelector('.mono')?.textContent===compactId(id,30)));
  }catch(error){notify(`Unable to inspect artifact: ${error.message}`,true)}
}
function roleKey(role) { return `${role?.role_id || ''}@${role?.version ?? ''}`; }
function renderRegistrySummary(targetId, values) {
  const target=$(targetId);clear(target);
  for(const [label,value,detail=''] of values){const card=el('div','registry-stat');append(card,el('span','registry-stat-label',label),el('strong','',fmtNumber(value)),detail?el('small','',detail):null);target.append(card);}
}
function inspectRole(role) {
  if(!role)return;state.selectedRoleKey=roleKey(role);
  const target=$('role-inspector-body');clear(target);target.className='role-inspector-body';
  $('role-inspector-title').textContent=role.name||role.role_id;
  $('role-inspector-subtitle').textContent=`${role.role_id}@${role.version} · created ${dateTime(role.created_at)}`;
  append(target,el('p','registry-description',role.description||'No description recorded.'));
  const facts=el('div','detail-facts');
  for(const [label,value] of [['ROLE ID',role.role_id],['VERSION',role.version],['OUTPUT',role.output_artifact_type],['CREATED BY',role.created_by]]){const box=el('div','detail-fact');append(box,el('span','',label),el('strong','',value??'—'));facts.append(box);}
  target.append(facts);
  const addList=(title,values)=>{const section=el('section','role-detail-section');section.append(el('h4','',title));const body=el('div','role-token-list');const entries=Array.isArray(values)?values:[];if(!entries.length)body.append(el('span','registry-muted','None declared'));else for(const value of entries)body.append(el('span','role-token',value));section.append(body);target.append(section);};
  addList('Accepted input artifacts',role.input_contract);addList('Declared capabilities',role.allowed_capabilities);addList('Permissions',role.permissions);addList('Allowed read-only tools',role.allowed_tools);
  const section=el('section','role-detail-section');append(section,el('h4','',`Attached Agent Skills · ${(role.skills||[]).length}`));
  if(!role.skills?.length)section.append(el('div','role-empty-note','No skill snapshot attached to this role version.'));
  for(const skill of role.skills||[]){
    const card=el('article','role-skill-card');append(card,el('strong','',skill.name||'Unnamed skill'),el('p','',skill.description||'No skill description recorded.'),el('small','',skill.source||'Unknown source'),el('small','mono',`SHA-256 ${skill.sha256||'not recorded'}`),el('small','',`${skill.supporting_files??0} supporting files · ${fmtNumber(skill.instruction_chars||0)} instruction characters`));
    if(skill.instructions_preview)card.append(blockText('SNAPSHOTTED SKILL INSTRUCTIONS',skill.instructions_preview));
    if(skill.files?.length)card.append(blockText('SUPPORTING FILE HASHES',skill.files.map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes}))));
    section.append(card);
  }
  target.append(section,blockText('SYSTEM PROMPT',role.system_prompt||''));
  document.querySelectorAll('#role-list tr[data-role-key]').forEach(row=>row.classList.toggle('selected',row.dataset.roleKey===state.selectedRoleKey));
}
async function inspectPinnedRole(roleId,version) {
  try{
    const data=await api(`/api/roles?versions=all&q=${encodeURIComponent(roleId)}&limit=200`);
    const role=(data.custom_roles||[]).find(item=>item.role_id===roleId&&Number(item.version)===Number(version));
    if(!role){$('role-search').value=roleId;state.roleVersions='all';$('role-version-filter').value='all';await loadRoles(true);notify(`Pinned role version ${roleId}@${version} is not available in the registry snapshot.`,true);return;}
    state.roleVersions='all';$('role-version-filter').value='all';state.selectedRoleKey=roleKey(role);await loadRoles(true);inspectRole(role);
  }catch(error){notify(`Unable to inspect pinned role: ${error.message}`,true);}
}
async function loadRoles(quiet=false) {
  try{
    state.roleQuery=$('role-search').value.trim();state.roleVersions=$('role-version-filter').value||'latest';
    const params=new URLSearchParams({q:state.roleQuery,versions:state.roleVersions,limit:'200'});
    const data=await api(`/api/roles?${params}`);state.roles=data;
    const summary=data.summary||{};
    $('nav-roles-count').textContent=fmtNumber(summary.custom_profiles||0);
    renderRegistrySummary('role-summary',[
      ['Built-in role IDs',summary.built_in_role_ids||0,'Fixed runtime contracts'],
      ['Custom profiles',summary.custom_profiles||0,'Saved role identities'],
      ['Stored versions',summary.custom_role_versions||0,'Immutable versions'],
      ['Attached skills',summary.attached_skills||0,'Latest version snapshots'],
      ['Custom workflows',summary.custom_workflows||0,'Role pins per task'],
      ['Built-in overlays',summary.builtin_profile_pins||0,'Proposal-pinned profiles']
    ]);
    $('role-list-caption').textContent=`${(data.custom_roles||[]).length} profile versions shown · ${state.roleVersions==='all'?'all versions':'latest version per profile'}`;
    const rolesBody=$('role-list');clear(rolesBody);
    if(!data.custom_roles?.length){const tr=el('tr'),td=el('td','table-empty','No custom role profile matches this filter. Built-in roles remain fixed runtime contracts.');td.colSpan=4;tr.append(td);rolesBody.append(tr);}
    for(const role of data.custom_roles||[]){
      const tr=el('tr');tr.dataset.roleKey=roleKey(role);tr.classList.toggle('selected',tr.dataset.roleKey===state.selectedRoleKey);tr.tabIndex=0;
      const title=el('td');const button=el('button','role-select-button');append(button,el('strong','',role.name),el('small','mono',role.role_id));button.addEventListener('click',()=>inspectRole(role));tr.addEventListener('keydown',e=>{if(e.key==='Enter')inspectRole(role)});title.append(button);
      const version=el('td','mono',`v${role.version}`);const output=el('td','',role.output_artifact_type||'—');const skills=el('td');const count=(role.skills||[]).length;skills.append(el('span',`status-pill ${count?'status-completed':'status-pending'}`,`${count} skill${count===1?'':'s'}`));append(tr,title,version,output,skills);rolesBody.append(tr);
    }
    const builtins=$('builtin-role-list');clear(builtins);
    if(!data.builtin_roles?.length){const tr=el('tr'),td=el('td','table-empty','No built-in role IDs found in the task ledger.');td.colSpan=3;tr.append(td);builtins.append(tr);}
    for(const role of data.builtin_roles||[]){const tr=el('tr');append(tr,el('td','mono',role.role),el('td','',fmtNumber(role.task_count)),el('td','',fmtNumber(role.job_count)));builtins.append(tr);}
    const pins=$('role-workflow-list');clear(pins);const pinRows=(data.custom_workflows||[]).flatMap(workflow=>(workflow.tasks||[]).map(task=>({workflow,task})));
    if(!pinRows.length){const tr=el('tr'),td=el('td','table-empty','No custom workflow role pins found. Built-in workflows use their fixed specialist contracts.');td.colSpan=5;tr.append(td);pins.append(tr);}
    for(const {workflow,task} of pinRows){const tr=el('tr');const workflowCell=el('td');append(workflowCell,el('strong','',workflow.name),el('small','mono',`${workflow.workflow_id}@${workflow.version}`));const roleCell=el('td');const roleButton=el('button','role-select-button');append(roleButton,el('strong','',task.role_name),el('small','mono',`${task.role_id}@${task.role_version}`));roleButton.addEventListener('click',()=>inspectPinnedRole(task.role_id,task.role_version));append(tr,workflowCell,el('td','mono',task.task_id),roleCell,el('td','',task.output_artifact_type),el('td','',task.skills?.length?task.skills.join(', '):'No skills'));roleCell.append(roleButton);pins.append(tr);}
    const overlayPins=$('builtin-role-profile-pin-list');clear(overlayPins);const overlays=data.builtin_role_profile_pins||[];
    if(!overlays.length){const tr=el('tr'),td=el('td','table-empty','No built-in workflow proposal has pinned a custom profile overlay.');td.colSpan=5;tr.append(td);overlayPins.append(tr);}
    for(const pin of overlays){const tr=el('tr');const workflowCell=el('td');append(workflowCell,el('strong','',pin.workflow_name||pin.job_id),el('small','mono',`${pin.workflow_id} · ${pin.job_id}`),el('small','',`Workflow status: ${pin.workflow_status||'unknown'} · proposal pin; approval/execution not implied`));const roleCell=el('td','mono',pin.built_in_role);const profileCell=el('td');const profileButton=el('button','role-select-button');append(profileButton,el('strong','',pin.role_name),el('small','mono',`${pin.role_id}@${pin.role_version}`));profileButton.addEventListener('click',()=>inspectPinnedRole(pin.role_id,pin.role_version));profileCell.append(profileButton);append(tr,workflowCell,roleCell,profileCell,el('td','mono',pin.profile_hash||'Hash unavailable'),el('td','',pin.skills?.length?pin.skills.join(', '):'No skills'));overlayPins.append(tr);}
    $('role-edit-note').textContent=data.edit_note||'This registry is read-only. Use the custom-role tools to change definitions.';
    const selected=(data.custom_roles||[]).find(role=>roleKey(role)===state.selectedRoleKey);
    if(selected)inspectRole(selected);else if(data.custom_roles?.length)inspectRole(data.custom_roles[0]);else{
      state.selectedRoleKey=null;$('role-inspector-title').textContent='No custom role selected';$('role-inspector-subtitle').textContent='Built-in runtime roles are fixed contracts.';const inspector=$('role-inspector-body');clear(inspector);inspector.className='inspector-placeholder';inspector.append(el('span','', 'Create a custom role through custom_role_create, then pin it into a custom workflow.'));
    }
  }catch(error){if(!quiet)notify(`Unable to load role registry: ${error.message}`,true);}
}
function inspectBatch(batch) {
  if(!batch)return;state.selectedBatchId=batch.batch_id;
  $('batch-inspector-title').textContent=`${batch.role} · ${batch.status}`;
  $('batch-inspector-subtitle').textContent=`${batch.batch_id} · attempt ${batch.attempt}`;
  const target=$('batch-inspector-body');clear(target);target.className='batch-inspector-body';
  const facts=el('div','detail-facts');for(const [label,value] of [['WORKFLOW',batch.job_title||batch.job_id],['ROLE',batch.role],['STATUS',batch.status],['ITEMS',`${batch.completed_items||0}/${batch.item_count||0} completed`],['CREATED',dateTime(batch.created_at)],['STARTED',dateTime(batch.started_at)],['FINISHED',dateTime(batch.finished_at)],['PARENT TASK',batch.parent_task_id||'—']]){const box=el('div','detail-fact');append(box,el('span','',label),el('strong','',value??'—'));facts.append(box);}target.append(facts);
  const openWorkflow=el('button','inspector-link','Open parent workflow');openWorkflow.addEventListener('click',()=>openJob(batch.job_id));target.append(openWorkflow);
  if(batch.aggregate_content)target.append(blockText('AGGREGATE OUTPUT',batch.aggregate_content));
  for(const item of batch.items||[]){const card=el('article','batch-item-card');append(card,el('strong','',`${item.item_id} · ${item.status}`),el('small','mono',item.task_id),el('p','mono',`$ ${item.command}`),el('small','',`Exit ${item.exit_code??'—'} · attempt ${item.attempt} · timeout ${item.timeout_ms??'—'} ms`),el('small','',item.cwd||'Working directory unavailable'));
    if(item.stdout)card.append(blockText('STDOUT',item.stdout));if(item.stderr)card.append(blockText('STDERR',item.stderr));if(item.error)card.append(blockText('ERROR',item.error));target.append(card);
  }
  if(batch.items_truncated)target.append(el('p','registry-footnote',`Showing ${batch.items?.length||0} of ${batch.items_total||0} batch items in this bounded response.`));
  document.querySelectorAll('#batch-list tr[data-batch-id]').forEach(row=>row.classList.toggle('selected',row.dataset.batchId===batch.batch_id));
}
async function openExecutionTask(item) {
  await openJob(item.job_id);
  if(!state.currentJob || state.currentJob.job?.job_id!==item.job_id)return;
  state.jobTab='tasks';renderJobDetail();
  const card=[...document.querySelectorAll('#job-detail-shell .detail-list-item')].find(node=>node.querySelector('small.mono')?.textContent===item.task_id);
  if(!card)return;
  card.classList.add('execution-focus');
  for(const disclosure of card.querySelectorAll('details'))disclosure.open=true;
  card.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
async function loadBatches(quiet=false) {
  try{
    state.batchQuery=$('batch-search').value.trim();state.batchStatus=$('batch-status-filter').value;
    const params=new URLSearchParams({q:state.batchQuery,status:state.batchStatus,limit:String(state.batchLimit),offset:String(state.batchOffset),executionLimit:String(state.individualExecutionLimit),executionOffset:String(state.individualExecutionOffset)});
    const data=await api(`/api/batches?${params}`);state.batches=data.items||[];state.batchTotal=Number(data.total||0);
    state.individualExecutions=data.individual_items||[];state.individualExecutionTotal=Number(data.individual_total||0);
    const statuses=mapCount(data.statuses,'status');const individualStatuses=mapCount(data.individual_statuses,'status');
    renderRegistrySummary('batch-summary',[
      ['Durable batches',data.summary?.batches||0,'execution_batches rows'],
      ['Batch items',data.summary?.items||0,'execution_batch_items rows'],
      ['Individual task runs',data.summary?.individual_executions||0,'Not grouped into batches'],
      ['Active batches',(statuses.RUNNING||0)+(statuses.WAITING||0),'Running or waiting'],
      ['Completed task runs',individualStatuses.COMPLETED||0,'ExecutionManager successes'],
      ['Failed task runs',individualStatuses.FAILED||0,'ExecutionManager failures']
    ]);
    $('nav-batches-count').textContent=fmtNumber(data.summary?.batches||0);
    $('batch-list-caption').textContent=`${fmtNumber(data.total)} matching batches · ${fmtNumber(data.summary?.items||0)} recorded items total`;
    $('individual-executions-caption').textContent=`${fmtNumber(data.individual_total)} matching individual task executions · these are real executions, but not batch records`;
    $('batch-empty-explanation').textContent=data.empty_explanation||'A batch exists only after a durable batch execution request.';
    const tbody=$('batch-list');clear(tbody);
    if(!state.batches.length){const tr=el('tr'),td=el('td','table-empty',state.batchQuery||state.batchStatus?'No execution batches match this filter.':'No execution batches have been recorded in the local SQLite database.');td.colSpan=6;tr.append(td);tbody.append(tr);}
    for(const batch of state.batches){const tr=el('tr');tr.tabIndex=0;tr.dataset.batchId=batch.batch_id;tr.classList.toggle('selected',batch.batch_id===state.selectedBatchId);const jobCell=el('td');append(jobCell,el('strong','',batch.job_title||batch.job_id),el('small','mono',compactId(batch.job_id,22)));const items=el('td',`${Number(batch.failed_items||0)?'batch-items-failed':''}`,`${batch.completed_items||0}/${batch.item_count||0}`);if(Number(batch.failed_items||0))items.title=`${batch.failed_items} failed items`;const created=el('td');created.append(relativeTime(batch.created_at));append(tr,jobCell,el('td','',batch.role),el('td','',pill(batch.status)),items,el('td','',batch.attempt),created);tr.addEventListener('click',()=>inspectBatch(batch));tr.addEventListener('keydown',e=>{if(e.key==='Enter')inspectBatch(batch)});tbody.append(tr);}
    renderPagination('batches-pagination',{total:state.batchTotal,offset:state.batchOffset,limit:state.batchLimit,onPrev:()=>{state.batchOffset=Math.max(0,state.batchOffset-state.batchLimit);loadBatches()},onNext:()=>{state.batchOffset+=state.batchLimit;loadBatches()}});
    const executions=$('individual-execution-list');clear(executions);
    if(!state.individualExecutions.length){const tr=el('tr'),td=el('td','table-empty',state.batchQuery||state.batchStatus?'No individual task executions match this filter.':'No individual ExecutionManager runs have been recorded.');td.colSpan=6;tr.append(td);executions.append(tr);}
    for(const item of state.individualExecutions){
      const tr=el('tr');tr.tabIndex=0;tr.dataset.taskId=item.task_id;
      const workflowCell=el('td','execution-job-cell');append(workflowCell,el('strong','',item.job_title||item.job_id),el('small','mono',compactId(item.task_id,22)));
      const roleCell=el('td','execution-role-cell');append(roleCell,el('strong','',item.role_display||item.role),el('small','mono',item.custom_role_id?item.role:'Built-in runtime role'));
      const finished=item.execution_finished_at||item.execution_started_at;
      const finishedCell=el('td');finishedCell.append(finished?relativeTime(finished):el('span','', '—'));
      append(tr,workflowCell,roleCell,pill(item.execution_status||item.task_status),el('td','',item.execution_exit_code==null?'—':String(item.execution_exit_code)),el('td','mono execution-session',compactId(item.execution_session_id||'',18)),finishedCell);
      tr.title='Open this task and its captured output';tr.addEventListener('click',()=>openExecutionTask(item));tr.addEventListener('keydown',e=>{if(e.key==='Enter')openExecutionTask(item)});executions.append(tr);
    }
    renderPagination('individual-executions-pagination',{total:state.individualExecutionTotal,offset:state.individualExecutionOffset,limit:state.individualExecutionLimit,onPrev:()=>{state.individualExecutionOffset=Math.max(0,state.individualExecutionOffset-state.individualExecutionLimit);loadBatches()},onNext:()=>{state.individualExecutionOffset+=state.individualExecutionLimit;loadBatches()}});
    const selected=state.batches.find(batch=>batch.batch_id===state.selectedBatchId);if(selected)inspectBatch(selected);else if(state.batches.length)inspectBatch(state.batches[0]);else{state.selectedBatchId=null;$('batch-inspector-title').textContent='No batch selected';$('batch-inspector-subtitle').textContent='No durable batch record is available.';const inspector=$('batch-inspector-body');clear(inspector);inspector.className='inspector-placeholder';inspector.append(el('span','', 'No batch record is selected. Individual task runs are listed below; they are not grouped batch records.'))}
  }catch(error){if(!quiet)notify(`Unable to load batch history: ${error.message}`,true);}
}
async function loadPolicies(quiet=false) {
  try {
    state.policyQuery=$('policy-search').value.trim();state.policyVersions=$('policy-version-filter').value||'latest';
    const params=new URLSearchParams({q:state.policyQuery,versions:state.policyVersions,limit:'200'});
    const data=await api(`/api/policies?${params}`);state.policies=data;
    const summary=data.summary||{};
    $('nav-policies-count').textContent=fmtNumber(summary.policy_count||0);
    renderRegistrySummary('policy-summary',[
      ['Policy packs',summary.policy_count||0,'Reusable policy identities'],
      ['Immutable versions',summary.policy_versions||0,'Stored content snapshots'],
      ['Workflow attachments',summary.attachments||0,'Exact version pins'],
      ['Audit events',summary.audit_events||0,'Append-only policy history'],
      ['Recorded violations',summary.recorded_violations||0,'Historical failed predicates; not automatically cleared']
    ]);
    $('policy-list-caption').textContent=`${(data.policies||[]).length} ${state.policyVersions==='all'?'stored versions':'latest policy versions'} shown · SHA-256 identifies the immutable definition`;
    const policies=$('policy-list');clear(policies);
    if(!data.policies?.length){const tr=el('tr'),td=el('td','table-empty',state.policyQuery?'No policy packs match this filter.':(data.note||'No workflow policy packs have been created. Use workflow_policy_create and workflow_policy_attach through the MCP tools.'));td.colSpan=6;tr.append(td);policies.append(tr);}
    for(const policy of data.policies||[]){
      const tr=el('tr');
      const name=el('td');append(name,el('strong','',policy.name),el('small','mono',policy.policy_id),el('small','',policy.description||'No description recorded.'));
      const rules=el('td');append(rules,el('span','status-pill status-live',`${policy.constraint_count||0} constraints`),el('span','status-pill status-live',`${policy.success_criteria_count||0} criteria`));
      const types=[...(policy.constraints||[]),...(policy.success_criteria||[])].map(rule=>`${rule.type||'unknown'} (${rule.id||'unidentified'})`);
      if(types.length)rules.title=types.join('\n');
      const hash=el('td','mono',policy.content_hash?`${policy.content_hash.slice(0,12)}…${policy.content_hash.slice(-8)}`:'Invalid/missing hash');hash.title=policy.content_hash||'';
      const validation=el('td');validation.append(pill(policy.validation_status||'unknown'),el('small','',`${policy.violation_count||0} recorded violation${Number(policy.violation_count||0)===1?'':'s'}`));if(policy.validation_reason)validation.title=policy.validation_reason;
      const created=el('td');created.append(policy.created_at?relativeTime(policy.created_at):el('span','','—'));
      if(policy.definition_truncated)created.append(el('small','status-failed','Definition preview truncated or malformed'));
      append(tr,name,el('td','mono',`v${policy.version}`),rules,hash,validation,created);policies.append(tr);
    }
    const attachments=$('policy-attachment-list');clear(attachments);
    if(!data.attachments?.length){const tr=el('tr'),td=el('td','table-empty','No workflow policy attachments match this filter. Packs may exist without being attached to a proposal.');td.colSpan=6;tr.append(td);attachments.append(tr);}
    for(const attachment of data.attachments||[]){
      const tr=el('tr');const workflow=el('td');append(workflow,el('strong','',attachment.job_title||attachment.job_id),el('small','mono',compactId(attachment.job_id,24)));
      const policy=el('td');append(policy,el('strong','',attachment.name||attachment.policy_id),el('small','mono',`${attachment.policy_id}@${attachment.version}`));
      const hash=el('td','mono',attachment.content_hash?`${attachment.content_hash.slice(0,12)}…${attachment.content_hash.slice(-8)}`:'Invalid/missing hash');hash.title=attachment.content_hash||'';
      const validation=el('td');validation.append(pill(attachment.validation_status||'unknown'));if(attachment.validation_reason)validation.title=attachment.validation_reason;
      const when=el('td');when.append(attachment.attached_at?relativeTime(attachment.attached_at):el('span','','—'));
      append(tr,workflow,policy,pill(attachment.job_state||attachment.job_status),hash,validation,when);tr.title=`Attached by ${attachment.attached_by||'unknown actor'}`;attachments.append(tr);
    }
    const events=$('policy-event-list');clear(events);
    if(!data.events?.length){const tr=el('tr'),td=el('td','table-empty','No policy audit events match this filter.');td.colSpan=5;tr.append(td);events.append(tr);}
    for(const event of data.events||[]){const tr=el('tr');const type=el('td');append(type,pill(event.event_type),el('small','mono',compactId(event.event_id,20)));const policy=el('td');append(policy,el('strong','',event.policy_id),el('small','mono',event.version?`v${event.version}`:'—'));const when=el('td');when.append(event.created_at?relativeTime(event.created_at):el('span','','—'));append(tr,type,policy,el('td','mono',event.version?`v${event.version}`:'—'),el('td','',event.created_by||'—'),when);tr.title=JSON.stringify(event.payload||{});events.append(tr);}
    if(data.enforcement_note)$('policies-view').dataset.enforcementNote=data.enforcement_note;
  } catch(error) {if(!quiet)notify(`Unable to load policy registry: ${error.message}`,true);}
}
async function loadFiles(relative='') {
  state.filePath=relative;try{const data=await api(`/api/files?path=${encodeURIComponent(relative)}`);const target=$('file-list');clear(target);$('file-breadcrumb').textContent=data.path?`/${data.root_label}/${data.path}`:`/${data.root_label}`;$('file-up').disabled=!data.parent;$('file-up').onclick=()=>loadFiles(data.parent||'');if(!data.entries.length)target.append(el('div','table-empty','No supported text/log files in this folder.'));for(const item of data.entries){const row=el('div',`file-row ${item.kind}`);append(row,el('span','file-glyph',item.kind==='directory'?'▰':'▤'),el('span','file-name',item.name),el('span','file-size',item.kind==='file'?humanSize(item.size):'DIR'),el('span','file-date',ago(item.modified_at)));row.title=item.path;row.addEventListener('click',()=>item.kind==='directory'?loadFiles(item.path):previewFile(item.path));target.append(row);}if(data.truncated)target.append(el('div','file-footnote','Showing the first 200 entries. Narrow folders to browse further.'));
  }catch(error){notify(`Unable to browse local files: ${error.message}`,true)}
}
function humanSize(value){const n=Number(value||0);if(n<1024)return `${n} B`;if(n<1024*1024)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(1)} MB`;}
async function previewFile(relative){
  try{const f=await api(`/api/files/preview?path=${encodeURIComponent(relative)}`);state.filePreviewPath=relative;$('file-preview-title').textContent=relative.split('/').pop();$('file-preview-meta').textContent=`${humanSize(f.size)} · modified ${dateTime(f.modified_at)}${f.truncated?' · PREVIEW TRUNCATED':''}`;$('file-preview-content').textContent=f.preview+(f.truncated?'\n\n[Preview truncated at 64 KB]':'');const copyPath=$('file-copy-path');if(copyPath)copyPath.disabled=false;notify(`Opened read-only preview: ${relative}`)}catch(error){notify(`File preview denied: ${error.message}`,true)}
}
async function refreshAll(quiet=false){if(refreshInFlight)return false;refreshInFlight=true;setSyncUi('syncing');let ok=false;try{ok=await refreshOverview();if(state.view==='agg')await loadAggGraph(true);if(state.view==='workflows')await loadJobs(quiet);if(state.view==='roles')await loadRoles(quiet);if(state.view==='policies')await loadPolicies(quiet);if(state.view==='batches')await loadBatches(quiet);if(state.view==='events')await loadEvents();if(state.view==='artifacts')await loadArtifacts();if(state.view==='files'&&state.filePath)await loadFiles(state.filePath);return ok;}finally{refreshInFlight=false;setSyncUi(ok?'success':'error');}}
function debounce(fn,delay=180){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),delay)}}
for(const b of document.querySelectorAll('.nav-item')) b.addEventListener('click',()=>setView(b.dataset.view));
for(const b of document.querySelectorAll('[data-open-view]')) b.addEventListener('click',()=>setView(b.dataset.openView));
 $('refresh-button').addEventListener('click',()=>refreshAll().then(ok=>{if(ok)notify('Snapshot refreshed');else notify('Refresh failed; last snapshot retained',true)}).catch(e=>notify(e.message,true)));
 $('hero-refresh').addEventListener('click',()=>refreshAll().then(ok=>{if(ok)notify('Snapshot refreshed');else notify('Refresh failed; last snapshot retained',true)}).catch(e=>notify(e.message,true)));
 $('global-search').value=state.jobQuery;$('workflow-status-filter').value=state.statusFilter;
 $('workflow-status-filter').addEventListener('change',()=>{state.statusFilter=$('workflow-status-filter').value;state.jobOffset=0;saveSessionPrefs();loadJobs()});
 $('workflow-phase-filter').addEventListener('change',()=>{state.phaseFilter=$('workflow-phase-filter').value;state.jobOffset=0;saveSessionPrefs();loadJobs()});
 for(const b of document.querySelectorAll('[data-quick-status]'))b.addEventListener('click',()=>{state.statusFilter=state.statusFilter===b.dataset.quickStatus?'':b.dataset.quickStatus;$('workflow-status-filter').value=state.statusFilter;state.jobOffset=0;saveSessionPrefs();loadJobs()});
 $('clear-workflow-filters').addEventListener('click',()=>{state.jobQuery='';state.statusFilter='';state.phaseFilter='';state.jobOffset=0;$('global-search').value='';$('workflow-status-filter').value='';$('workflow-phase-filter').value='';saveSessionPrefs();loadJobs()});
for(const b of document.querySelectorAll('[data-attention-filter]'))b.addEventListener('click',()=>renderAttentionList(state.attentionFilter===b.dataset.attentionFilter?'all':b.dataset.attentionFilter));
$('event-search').addEventListener('input',debounce(()=>{state.eventOffset=0;loadEvents()}));
$('event-type-filter').addEventListener('change',()=>{state.eventOffset=0;loadEvents()});
$('agg-refresh').addEventListener('click',()=>loadAggGraph());
$('agg-neighborhood-toggle').addEventListener('click',()=>{if(!state.aggSelectedNode)return;state.aggShowNeighborhood=!state.aggShowNeighborhood;renderAggGraph(state.aggGraph||{available:false});});
$('agg-export-svg').addEventListener('click',()=>exportAggSvg('#agg-graph-canvas svg',`agg-knowledge-graph-${new Date().toISOString().slice(0,10)}.svg`));
$('agg-export-json').addEventListener('click',()=>{const data=state.aggGraph;if(!data?.available)return notify('No knowledge graph snapshot is available',true);let nodes=data.nodes||[],edges=data.edges||[];if(state.aggShowNeighborhood&&state.aggSelectedNode){const ids=new Set([state.aggSelectedNode]);for(const edge of edges)if(edge.from===state.aggSelectedNode||edge.to===state.aggSelectedNode){ids.add(edge.from);ids.add(edge.to);}nodes=nodes.filter(node=>ids.has(node.id));edges=edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to));}const payload={schema_version:1,exported_at:new Date().toISOString(),filters:data.filters,goal_filter:data.goal_filter,query:data.query,focus_node_id:state.aggShowNeighborhood?state.aggSelectedNode:null,summary:{...data.summary,visible_nodes:nodes.length,visible_edges:edges.length},nodes,edges,planning:data.planning,observability_note:data.observability_note};downloadAggFile(JSON.stringify(payload,null,2),'application/json',`agg-knowledge-graph-${new Date().toISOString().slice(0,10)}.json`);});
$('agg-reset-filters').addEventListener('click',()=>{state.aggGoal='';state.aggType='';state.aggSearch='';state.aggIncludeRecovery=false;state.aggShowNeighborhood=false;state.aggSelectedNode=null;state.aggNodeDetail=null;$('agg-goal-filter').value='';$('agg-type-filter').value='';$('agg-search').value='';$('agg-recovery-filter').checked=false;$('agg-neighborhood-toggle').disabled=true;$('agg-node-inspector').replaceChildren(el('div','agg-empty','Select a graph node to inspect its revision, SHA-256, memberships, evidence references and provenance.'));setAggRunUrl(state.aggRunSelected);loadAggGraph();});

$('agg-runs-refresh').addEventListener('click',()=>loadAggRuns().catch(error=>renderAggRunAvailability(`Unable to refresh AGG run history: ${error.message}`,'error')));
$('agg-run-quick-select').addEventListener('change',event=>{if(event.target.value)loadAggRunDetail(event.target.value).catch(error=>notify(`Unable to open selected AGG run: ${error.message}`,true));});
$('agg-run-graph-search').addEventListener('input',debounce(()=>applyAggRunGraphControls(),100));
$('agg-run-graph-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyAggRunGraphControls({scrollToMatch:true});}});
$('agg-run-graph-type-filter').addEventListener('change',()=>applyAggRunGraphControls());
$('agg-run-graph-show-secondary').addEventListener('change',()=>applyAggRunGraphControls());
$('agg-run-graph-clear').addEventListener('click',()=>{state.aggRunGraphQuery='';state.aggRunGraphType='';$('agg-run-graph-search').value='';$('agg-run-graph-type-filter').value='';applyAggRunGraphControls();});
$('agg-run-graph-reset-view').addEventListener('click',resetAggRunGraphControls);
$('agg-run-graph-zoom').addEventListener('input',event=>setAggRunGraphZoom(event.target.value));
$('agg-run-copy-link').addEventListener('click',()=>copyText(window.location.href,'Run link'));
$('agg-run-copy-node').addEventListener('click',()=>copyText(state.aggRunGraphSelectedNode,'Node ID'));
$('agg-run-export-json').addEventListener('click',exportAggRunJson);
$('agg-run-export-svg').addEventListener('click',()=>exportAggSvg('#agg-run-graph-stage svg',`agg-run-${state.aggRunSelected||'graph'}.svg`));

$('agg-run-search').addEventListener('input',debounce(()=>{state.aggRunOffset=0;state.aggRunSince='';state.aggRunUntil='';loadAggRuns(true).catch(error=>renderAggRunAvailability(`Unable to search AGG runs: ${error.message}`,'error'));},220));
$('agg-run-status-filter').addEventListener('change',()=>{state.aggRunOffset=0;state.aggRunSince='';state.aggRunUntil='';loadAggRuns(true).catch(error=>renderAggRunAvailability(`Unable to filter AGG run status: ${error.message}`,'error'));});
$('agg-run-tool-filter').addEventListener('change',()=>{state.aggRunOffset=0;state.aggRunSince='';state.aggRunUntil='';loadAggRuns(true).catch(error=>renderAggRunAvailability(`Unable to filter AGG search tools: ${error.message}`,'error'));});
$('agg-run-goal-filter').addEventListener('change',()=>{state.aggRunOffset=0;state.aggRunSince='';state.aggRunUntil='';loadAggRuns(true).catch(error=>renderAggRunAvailability(`Unable to filter AGG goal scope: ${error.message}`,'error'));});
$('agg-run-node-filter').addEventListener('input',debounce(()=>{state.aggRunOffset=0;state.aggRunSince='';state.aggRunUntil='';loadAggRuns(true).catch(error=>renderAggRunAvailability(`Unable to filter AGG node links: ${error.message}`,'error'));},220));
$('agg-run-filters-clear').addEventListener('click',()=>{
  $('agg-run-search').value='';$('agg-run-status-filter').value='';$('agg-run-tool-filter').value='';$('agg-run-goal-filter').value='';$('agg-run-node-filter').value='';
  state.aggRunQuery='';state.aggRunStatus='';state.aggRunTool='';state.aggRunGoal='';state.aggRunNode='';state.aggRunSince='';state.aggRunUntil='';state.aggRunOffset=0;
  loadAggRuns().catch(error=>renderAggRunAvailability(`Unable to clear AGG run filters: ${error.message}`,'error'));
});
$('agg-run-newer').addEventListener('click',()=>{state.aggRunOffset=Math.max(0,state.aggRunOffset-state.aggRunLimit);loadAggRuns().catch(error=>renderAggRunAvailability(error.message,'error'));});
$('agg-run-older').addEventListener('click',()=>{state.aggRunOffset+=state.aggRunLimit;loadAggRuns().catch(error=>renderAggRunAvailability(error.message,'error'));});
$('agg-copy-snapshot').addEventListener('click',()=>{
  const data=state.aggGraph;if(!data?.available){notify('No AGG snapshot available to copy',true);return;}
  const snapshot={generated_at:data.generated_at,filters:data.filters,goal_filter:data.goal_filter,summary:data.summary,nodes:data.nodes,edges:data.edges,planning:data.planning,observability_note:data.observability_note};
  copyText(JSON.stringify(snapshot,null,2),'Filtered AGG graph snapshot');
});
$('agg-goal-filter').addEventListener('change',()=>loadAggGraph());
$('agg-type-filter').addEventListener('change',()=>loadAggGraph());
$('agg-search').addEventListener('input',debounce(()=>loadAggGraph(true),220));
$('agg-recovery-filter').addEventListener('change',()=>loadAggGraph());
$('agg-zoom-out').addEventListener('click',()=>{state.aggZoom=Math.max(.35,state.aggZoom-.15);renderAggGraph(state.aggGraph);});
$('agg-zoom-in').addEventListener('click',()=>{state.aggZoom=Math.min(1.6,state.aggZoom+.15);renderAggGraph(state.aggGraph);});
$('agg-zoom-reset').addEventListener('click',()=>{
  const scroll=$('agg-graph-scroll'),svg=$('agg-graph-canvas').querySelector('svg'),viewBox=svg?.viewBox?.baseVal;
  if(!viewBox?.width||!viewBox?.height){state.aggZoom=1;renderAggGraph(state.aggGraph);return;}
  const fitWidth=Math.max(.35,(scroll.clientWidth-32)/viewBox.width),fitHeight=Math.max(.35,(scroll.clientHeight-32)/viewBox.height);
  state.aggZoom=Math.min(1,fitWidth,fitHeight);renderAggGraph(state.aggGraph);
});
$('artifact-search').addEventListener('input',debounce(()=>{state.artifactOffset=0;loadArtifacts()}));
$('artifact-type-filter').addEventListener('change',()=>{state.artifactOffset=0;loadArtifacts()});
 $('role-search').addEventListener('input',debounce(()=>loadRoles(true)));
 $('role-version-filter').addEventListener('change',()=>loadRoles());
 $('policy-search').addEventListener('input',debounce(()=>loadPolicies(true)));
 $('policy-version-filter').addEventListener('change',()=>loadPolicies());
 $('batch-search').addEventListener('input',debounce(()=>{state.batchOffset=0;state.individualExecutionOffset=0;loadBatches(true)}));
 $('batch-status-filter').addEventListener('change',()=>{state.batchOffset=0;state.individualExecutionOffset=0;loadBatches()});
$('file-refresh').addEventListener('click',()=>loadFiles(state.filePath));
 $('global-search').addEventListener('input',debounce(()=>{state.jobQuery=$('global-search').value.trim();saveSessionPrefs();if(state.view==='workflows'){state.jobOffset=0;loadJobs(true)}},180));
 $('global-search').addEventListener('keydown',e=>{if(e.key==='Enter'){state.jobQuery=$('global-search').value.trim();state.jobOffset=0;saveSessionPrefs();setView('workflows');$('global-search').blur();}if(e.key==='Escape'){$('global-search').value='';state.jobQuery='';state.jobOffset=0;saveSessionPrefs();if(state.view==='workflows')loadJobs(true)}});
 const previewHead=document.querySelector('.preview-head');if(previewHead){const limit=previewHead.querySelector('.preview-limit');const actions=el('div','preview-actions');const copyPath=el('button','copy-button','Copy path');copyPath.id='file-copy-path';copyPath.disabled=true;copyPath.addEventListener('click',()=>copyText(state.filePreviewPath,'File path'));append(actions,limit,copyPath);previewHead.append(actions);}
 document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();$('global-search').focus();}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshAll(true)});
const initialParams=new URLSearchParams(window.location.search);
state.aggRunSelected=initialParams.get('run_id');
if(initialParams.get('node_id')){$('agg-search').value=initialParams.get('node_id');state.aggSearch=initialParams.get('node_id');state.aggSelectedNode=initialParams.get('node_id');}
const initialView=initialParams.get('view');
if(initialView&&views.includes(initialView))setView(initialView);
refreshAll(true);
pollTimer=setInterval(()=>{if(document.visibilityState==='visible'&&state.autoRefresh)refreshAll(true)},20000);
window.addEventListener('beforeunload',()=>clearInterval(pollTimer));
