// ─────────────────────────────────────────────────────────────────────────────
// Trello  <->  GitHub  —  sincronização via GitHub Actions
//
// Sem dependências (usa fetch nativo do Node 20+). É só rodar `node sync.mjs`.
//
// MODELO (importante):
//   Cada par card<->issue tem UMA fonte da verdade, definida pela origem:
//     • Card criado no Trello  -> vira issue "trello-origin".  O CARD manda.
//       (título, estado, etiquetas, responsáveis, descrição, checklists e
//        anexos são espelhados PARA a issue; editar a issue à mão é sobrescrito.)
//     • Issue criada no GitHub -> vira card "github-origin".   A ISSUE manda.
//       (título, estado, labels e corpo são espelhados PARA o card.)
//   Isso evita loop infinito e deixa claro quem sobrescreve quem.
//
// COMO IDENTIFICAR issue vinda do Trello: ela recebe a label `trello-sync` e um
//   marcador oculto no corpo: <!-- trello-sync:card=<ID> -->. Só issues com esse
//   marcador são atualizadas quando o card muda.
//
// Variáveis de ambiente (as 4 primeiras são obrigatórias):
//   TRELLO_KEY, TRELLO_TOKEN     -> credenciais do Trello
//   TRELLO_BOARD_ID              -> id do board (o código curto da URL serve)
//   GH_TOKEN                     -> token do GitHub (o GITHUB_TOKEN da Action serve)
//   GH_REPO                      -> "owner/repo" (github.repository já traz isso)
//   TRELLO_DONE_LIST             -> nome da lista que representa "fechado" (default: Done)
//   TRELLO_NEW_CARD_LIST         -> lista onde caem cards vindos de issues (default: 1ª lista)
//   MEMBER_MAP                   -> "trelloUser:githubLogin,trelloUser2:githubLogin2"
//                                   (jeito CONFIÁVEL de casar responsáveis — veja README)
//   MIRROR_ISSUES_TO_TRELLO      -> "false" desliga a criação de cards a partir de issues
//   SYNC_LABEL                   -> nome da label marcadora (default: trello-sync)
//   TZ_NAME, QUIET_START, QUIET_END -> janela de silêncio (default: America/Recife, 0, 6)
//   STATE_FILE                   -> arquivo de estado (default: .trello-sync-state.json)
//   DRY_RUN                      -> "true" só loga, não escreve nada
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;
const req = (k) => {
  const v = env[k];
  if (!v) { console.error(`❌ Falta a variável de ambiente ${k}`); process.exit(1); }
  return v;
};

const TRELLO_KEY   = req('TRELLO_KEY');
const TRELLO_TOKEN = req('TRELLO_TOKEN');
const BOARD_ID     = req('TRELLO_BOARD_ID');
const GH_TOKEN     = req('GH_MY_TOKEN');

console.log('GH_TOKEN', GH_TOKEN);

const [OWNER, REPO] = req('GH_REPO').split('/');

const DONE_LIST_NAME     = (env.TRELLO_DONE_LIST || 'Done').trim();
const NEW_CARD_LIST_NAME = (env.TRELLO_NEW_CARD_LIST || '').trim();
const SYNC_LABEL         = (env.SYNC_LABEL || 'trello-sync').trim();
const STATE_FILE         = env.STATE_FILE || '.trello-sync-state.json';
const TZ                 = env.TZ_NAME || 'America/Recife';
const QUIET_START        = Number(env.QUIET_START ?? 0);
const QUIET_END          = Number(env.QUIET_END ?? 6);
const DRY_RUN            = String(env.DRY_RUN || 'false') === 'true';
const _mirror            = (env.MIRROR_ISSUES_TO_TRELLO ?? 'true').toString().trim();
const MIRROR             = _mirror === '' ? true : _mirror === 'true';

// MEMBER_MAP: casa membro do Trello com login do GitHub (nos dois sentidos)
const t2gMember = new Map(); // trelloUsername(lower) -> githubLogin
const g2tMember = new Map(); // githubLogin(lower)    -> trelloUsername
for (const pair of (env.MEMBER_MAP || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const [t, g] = pair.split(':').map(x => x && x.trim());
  if (t && g) { t2gMember.set(t.toLowerCase(), g); g2tMember.set(g.toLowerCase(), t); }
}

console.log({ t2gMember, g2tMember});

// ── Janela de silêncio (00:00–06:00 no fuso local, por padrão) ────────────────
const localHour = Number(
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date())
) % 24;
const inQuiet = QUIET_START < QUIET_END
  ? (localHour >= QUIET_START && localHour < QUIET_END)
  : (localHour >= QUIET_START || localHour < QUIET_END);
if (inQuiet) {
  console.log(`🌙 ${localHour}h em ${TZ} está na janela de silêncio [${QUIET_START}h–${QUIET_END}h). Nada a fazer.`);
  process.exit(0);
}

// ── Helpers de API ────────────────────────────────────────────────────────────
const sha1 = (o) => crypto.createHash('sha1').update(typeof o === 'string' ? o : JSON.stringify(o)).digest('hex');
const sortA = (a) => (a || []).slice().sort();
// normaliza p/ comparar nomes de lista sem depender de acento/maiúscula
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function trello(path, { method = 'GET', params = {} } = {}) {
  const url = new URL('https://api.trello.com/1' + path);
  url.searchParams.set('key', TRELLO_KEY);
  url.searchParams.set('token', TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`Trello ${method} ${path} -> ${res.status} ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'trello-github-sync',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
async function ghPaged(path) {
  console.log('path executing', path);
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (!batch || !batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// ── Estado (mapeamento + hash de conteúdo já sincronizado) ────────────────────
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { pairs: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); }

// ── Coleta de dados ───────────────────────────────────────────────────────────
console.log('📥 Lendo Trello e GitHub…');

const lists = await trello(`/boards/${BOARD_ID}/lists`, { params: { fields: 'name' } });
const listByName   = new Map(lists.map(l => [norm(l.name), l.id]));
const listNameById = new Map(lists.map(l => [l.id, l.name]));

// "Concluído" = fechado. Aceita vários nomes (separados por vírgula) e casa por
// trecho, sem acento/maiúscula. Default cobre PT ("conclu…") e EN ("done").
const DONE_PATTERNS = ((env.TRELLO_DONE_LIST && env.TRELLO_DONE_LIST.trim()) ? env.TRELLO_DONE_LIST : 'done,conclu')
  .split(',').map(s => norm(s)).filter(Boolean);
const doneListIds = new Set(
  lists.filter(l => DONE_PATTERNS.some(p => norm(l.name) === p || norm(l.name).includes(p))).map(l => l.id)
);
const primaryDoneListId = [...doneListIds][0] || null; // p/ onde mover card quando a issue fecha
const newCardListId = (NEW_CARD_LIST_NAME && listByName.get(norm(NEW_CARD_LIST_NAME))) || (lists[0] && lists[0].id);

const boardLabels = await trello(`/boards/${BOARD_ID}/labels`, { params: { fields: 'name,color', limit: 1000 } });
const labelById   = new Map(boardLabels.map(l => [l.id, l]));
const labelByName = new Map(boardLabels.filter(l => l.name).map(l => [l.name.toLowerCase(), l]));

const boardMembers = await trello(`/boards/${BOARD_ID}/members`, { params: { fields: 'username,fullName' } });
console.log(boardMembers);
const memberById = new Map();
for (const m of boardMembers) {
  let email = null;
  try { const full = await trello(`/members/${m.id}`, { params: { fields: 'username,fullName,email' } }); email = full.email || null; } catch {}
  memberById.set(m.id, { id: m.id, username: m.username, fullName: m.fullName, email });
}
const memberByUsername = new Map([...memberById.values()].map(m => [m.username.toLowerCase(), m]));
const memberByEmail    = new Map([...memberById.values()].filter(m => m.email).map(m => [m.email.toLowerCase(), m]));

const cards = await trello(`/boards/${BOARD_ID}/cards`, {
  params: {
    filter: 'all',
    fields: 'name,desc,idList,idLabels,idMembers,shortUrl,closed',
    attachments: 'true', attachment_fields: 'name,url',
    checklists: 'all', checklist_fields: 'name',
  },
});

const allIssues = (await ghPaged(`/repos/${OWNER}/${REPO}/issues?state=all`)).filter(i => !i.pull_request);
const repoLabels = new Set((await ghPaged(`/repos/${OWNER}/${REPO}/labels`)).map(l => l.name.toLowerCase()));
// Só é possível atribuir como responsável quem tem acesso ao repo (colaboradores).
// Guardamos lower->loginReal para casar sem depender de maiúsculas.
const assignableByLower = new Map(
    (await ghPaged(`/repos/${OWNER}/${REPO}/collaborators`).then(r => {console.log('assignees', r); return r})
  ).map(u => [u.login.toLowerCase(), u.login]));

console.log('assignableByLower', assignableByLower);

const issueByNumber = new Map(allIssues.map(i => [i.number, i]));
const cardById      = new Map(cards.map(c => [c.id, c]));

// ── Descoberta de pares (resiliente mesmo sem o arquivo de estado) ────────────
const cardToIssue = new Map(); // cardId -> issueNumber
const issueToCard = new Map(); // issueNumber -> cardId
const originOf    = new Map(); // cardId -> 'trello' | 'github'

// trello-origin: pelo marcador no corpo da issue
for (const iss of allIssues) {
  const m = (iss.body || '').match(/<!--\s*trello-sync:card=([a-z0-9]+)\s*-->/i);
  if (m) { cardToIssue.set(m[1], iss.number); issueToCard.set(iss.number, m[1]); originOf.set(m[1], 'trello'); }
}
// github-origin: pelo anexo do card apontando para a issue
const issueUrlRe = new RegExp(`github\\.com/${OWNER}/${REPO}/issues/(\\d+)`, 'i');
for (const c of cards) {
  if (cardToIssue.has(c.id)) continue;
  for (const at of (c.attachments || [])) {
    const m = (at.url || '').match(issueUrlRe);
    if (m) { const n = Number(m[1]); cardToIssue.set(c.id, n); issueToCard.set(n, c.id); originOf.set(c.id, 'github'); break; }
  }
}

// ── Tradução de etiquetas/labels ──────────────────────────────────────────────
const TRELLO_HEX = { green: '0e8a16', yellow: 'fbca04', orange: 'd93f0b', red: 'd73a4a', purple: '5319e7', blue: '1d76db', sky: 'a2eeef', lime: 'bfdadc', pink: 'f9a8d4', black: '24292f' };

async function ensureGhLabel(name, color) {
  if (repoLabels.has(name.toLowerCase())) return;
  if (!DRY_RUN) await gh(`/repos/${OWNER}/${REPO}/labels`, { method: 'POST', body: { name, color: color || 'ededed' } }).catch(() => {});
  repoLabels.add(name.toLowerCase());
}
async function ensureTrelloLabel(name) {
  const ex = labelByName.get(name.toLowerCase());
  if (ex) return ex.id;
  if (DRY_RUN) return null;
  const created = await trello('/labels', { method: 'POST', params: { name, color: 'blue', idBoard: BOARD_ID } });
  labelById.set(created.id, created);
  labelByName.set(name.toLowerCase(), created);
  return created.id;
}
const cardLabelObjs  = (c) => (c.idLabels || []).map(id => labelById.get(id)).filter(l => l && l.name);
const cardLabelNames = (c) => cardLabelObjs(c).map(l => l.name).sort();

// ── Tradução de responsáveis ──────────────────────────────────────────────────
// Ordem de tentativa: MEMBER_MAP -> mesmo @username no GitHub -> email (se exposto).
// Cada candidato só é aceito se puder ser atribuído no repo (é colaborador).
const loginMemo = new Map();
async function ghLoginForMember(mid) {
  if (loginMemo.has(mid)) return loginMemo.get(mid);
  const m = memberById.get(mid);
  let result = null;
  if (m) {
    const cands = [];
    const mapped = t2gMember.get(m.username.toLowerCase());
    console.log('1 mapped', mapped);
    if (mapped) cands.push(mapped);       // 1) mapeamento manual (mais confiável)
    cands.push(m.username);               // 2) muita gente reusa o mesmo @ nos dois
    console.log('1 cands', cands);
    if (m.username) {                     // 3) username, quando o Trello expõe
      try { 
        console.log('1 m', m)
        const r = await gh(`/search/users?q=${encodeURIComponent(m.username)}+in:username`);
        console.log('result', r);
        if (r?.items?.[0]) cands.push(r.items[0].login); 
      } catch (error){
        console.log('error in ghLoginForMember', error);
      }
    }
    for (const c of cands) { 
      const hit = assignableByLower.get(String(c).toLowerCase());
      console.log('hit', hit);
      console.log('2 cands', c);
      if (hit) { result = hit; break; } 
    }
  }
  loginMemo.set(mid, result);

  console.log('mid', mid);
  console.log('result', result);
  return result;
}
async function resolveAssignees(card) {
  const out = [];
  for (const mid of (card.idMembers || [])) { const l = await ghLoginForMember(mid); if (l && !out.includes(l)) out.push(l); }
  return out.sort();
}

// ── Composição do corpo da issue a partir do card ─────────────────────────────
const clean = (s) => (s || '').replace(/[\[\]]/g, '');
function checklistMd(c) {
  let s = '';
  for (const cl of (c.checklists || [])) {
    s += `\n### ☑️ ${cl.name}\n`;
    for (const it of (cl.checkItems || []).slice().sort((a, b) => a.pos - b.pos)) {
      s += `- [${it.state === 'complete' ? 'x' : ' '}] ${it.name}\n`;
    }
  }
  return s;
}
function attachmentsMd(c) {
  const at = (c.attachments || []).filter(a => a.url);
  if (!at.length) return '';
  let s = '\n### 📎 Anexos\n';
  for (const a of at) s += `- [${clean(a.name || a.url).replace(/\n/g, ' ')}](${a.url})\n`;
  return s;
}
function trelloBlock(c) {
  let s = `<!-- trello-sync:card=${c.id} -->\n`;
  s += `> 🔄 Sincronizado automaticamente do card [${clean(c.name)}](${c.shortUrl}). Edite pelo Trello — esta seção é sobrescrita a cada sync.\n\n`;
  s += (c.desc && c.desc.trim()) ? c.desc.trim() + '\n' : '_(Card sem descrição no Trello.)_\n';
  s += checklistMd(c);
  s += attachmentsMd(c);
  s += `\n<!-- /trello-sync -->`;
  return s;
}
const END_TAG = '<!-- /trello-sync -->';
function injectBlock(body, c) {
  const block = trelloBlock(c);
  const start = body ? body.indexOf('<!-- trello-sync:card=') : -1;
  if (start >= 0 && body.indexOf(END_TAG) >= 0) {
    const end = body.indexOf(END_TAG) + END_TAG.length;
    return body.slice(0, start) + block + body.slice(end);
  }
  return body ? body.trimEnd() + '\n\n' + block : block;
}
function stripBlock(body) {
  if (!body) return '';
  const s = body.indexOf('<!-- trello-sync:card=');
  const e = body.indexOf(END_TAG);
  if (s >= 0 && e >= 0) return (body.slice(0, s) + body.slice(e + END_TAG.length)).trim();
  return body.trim();
}

const cardState = (c) => (c.closed || doneListIds.has(c.idList)) ? 'closed' : 'open';

// ── Aplicadores ───────────────────────────────────────────────────────────────
async function applyIssueFromCard(iss, card, desired) {
  for (const n of desired.labels) await ensureGhLabel(n, TRELLO_HEX[labelByName.get(n.toLowerCase())?.color] || 'ededed');
  const labels = [...new Set([...desired.labels, SYNC_LABEL])];
  const patch = { title: desired.title, state: desired.state, labels, body: injectBlock(iss.body || '', card) };
  if (DRY_RUN) { console.log(`   [dry] atualizaria issue #${iss.number}`); return; }
  try { await gh(`/repos/${OWNER}/${REPO}/issues/${iss.number}`, { method: 'PATCH', body: { ...patch, assignees: desired.assignees } }); }
  catch { await gh(`/repos/${OWNER}/${REPO}/issues/${iss.number}`, { method: 'PATCH', body: patch }); } // responsável não atribuível -> ignora
}
async function applyCardFromIssue(card, desired) {
  const idLabels = [];
  for (const n of desired.labels) { const id = await ensureTrelloLabel(n); if (id) idLabels.push(id); }
  const params = { name: desired.title, desc: desired.desc.slice(0, 16000), idLabels };
  if (desired.state === 'closed') { if (primaryDoneListId) params.idList = primaryDoneListId; }
  else if (doneListIds.has(card.idList)) { params.idList = newCardListId; }
  if (DRY_RUN) { console.log(`   [dry] atualizaria card ${card.id}`); return; }
  await trello(`/cards/${card.id}`, { method: 'PUT', params });
}

// desejos + hash de conteúdo (o hash compara "o que quero escrever agora" com
// "o que escrevi da última vez" — à prova de loop e de normalização do outro lado)
async function desiredIssue(card) {
  return {
    title: card.name,
    state: cardState(card),
    labels: cardLabelNames(card),
    assignees: await resolveAssignees(card),
    body: trelloBlock(card),
  };
}
function desiredCard(iss) {
  return {
    title: iss.title,
    state: iss.state,
    labels: (iss.labels || []).map(l => l.name).filter(n => n.toLowerCase() !== SYNC_LABEL.toLowerCase()).sort(),
    desc: stripBlock(iss.body),
  };
}

async function createIssueFromCard(card, state) {
  const d = await desiredIssue(card);
  for (const n of d.labels) await ensureGhLabel(n, TRELLO_HEX[labelByName.get(n.toLowerCase())?.color] || 'ededed');
  const labels = [...new Set([...d.labels, SYNC_LABEL])];
  if (DRY_RUN) { console.log(`   [dry] criaria issue do card "${card.name}"`); return; }
  const payload = { title: d.title, body: d.body, labels };
  if (d.assignees.length) payload.assignees = d.assignees;
  let created;
  try { created = await gh(`/repos/${OWNER}/${REPO}/issues`, { method: 'POST', body: payload }); }
  catch { delete payload.assignees; created = await gh(`/repos/${OWNER}/${REPO}/issues`, { method: 'POST', body: payload }); }
  if (d.state === 'closed') await gh(`/repos/${OWNER}/${REPO}/issues/${created.number}`, { method: 'PATCH', body: { state: 'closed' } });
  state.pairs[card.id] = { issue: created.number, origin: 'trello', hash: sha1(d) };
  console.log(`   ✅ Issue #${created.number} criada do card "${card.name}"`);
}

async function createCardFromIssue(iss, state) {
  if (!newCardListId) { console.warn('   ⚠️  Sem lista de destino no board; pulando criação de card.'); return; }
  const d = desiredCard(iss);
  if (DRY_RUN) { console.log(`   [dry] criaria card da issue #${iss.number}`); return; }
  const card = await trello('/cards', { method: 'POST', params: { idList: newCardListId, name: d.title, desc: d.desc.slice(0, 16000) } });
  const idLabels = [];
  for (const n of d.labels) { const id = await ensureTrelloLabel(n); if (id) idLabels.push(id); }
  if (idLabels.length) await trello(`/cards/${card.id}`, { method: 'PUT', params: { idLabels } });
  await trello(`/cards/${card.id}/attachments`, { method: 'POST', params: { url: iss.html_url, name: `GitHub Issue #${iss.number}` } });
  if (d.state === 'closed' && primaryDoneListId) await trello(`/cards/${card.id}`, { method: 'PUT', params: { idList: primaryDoneListId } });
  state.pairs[card.id] = { issue: iss.number, origin: 'github', hash: sha1(d) };
  console.log(`   ✅ Card "${iss.title}" criado da issue #${iss.number}`);
}

// ── Diagnóstico (ajuda a conferir o que está pareando) ────────────────────────
console.log(`🏁 Lista(s) tratada(s) como CONCLUÍDO (viram issue fechada): ${[...doneListIds].map(id => `"${listNameById.get(id)}"`).join(' | ') || '⚠️ NENHUMA — nada será fechado! Confira TRELLO_DONE_LIST.'}`);
console.log(`📥 Cards vindos de issues cairão na lista: "${listNameById.get(newCardListId) || '?'}"`);
console.log('👤 Membros do board × responsável no GitHub:');
for (const m of memberById.values()) {
  const login = await ghLoginForMember(m.id);
  console.log(`   • @${m.username}${m.fullName ? ` (${m.fullName})` : ''} -> ${login ? `@${login} ✅` : '❌ sem correspondência (adicione ao MEMBER_MAP e convide como colaborador do repo)'}`);
}

// ── Loop principal ────────────────────────────────────────────────────────────
const state = loadState();
if (!state.pairs) state.pairs = {};
let changes = 0;

console.log(`🔁 ${cards.length} cards, ${allIssues.length} issues. Sincronizando…`);

// 1) Cards -> issues (e atualização de pares existentes conforme a origem)
for (const card of cards) {
  if (card.closed) { // arquivado
    const num = cardToIssue.get(card.id);
    if (num && originOf.get(card.id) === 'trello') {
      const iss = issueByNumber.get(num);
      if (iss && iss.state !== 'closed') { if (!DRY_RUN) await gh(`/repos/${OWNER}/${REPO}/issues/${num}`, { method: 'PATCH', body: { state: 'closed' } }); console.log(`   ↩︎ Issue #${num} fechada (card arquivado)`); changes++; }
    }
    continue;
  }

  const num = cardToIssue.get(card.id);
  if (!num) { await createIssueFromCard(card, state); changes++; continue; }

  const iss = issueByNumber.get(num);
  if (!iss) { // issue sumiu -> recria a partir do card
    if (originOf.get(card.id) === 'trello') { delete state.pairs[card.id]; await createIssueFromCard(card, state); changes++; }
    continue;
  }

  const st = state.pairs[card.id] || (state.pairs[card.id] = { issue: num, origin: originOf.get(card.id) || 'trello' });
  st.issue = num;

  if ((originOf.get(card.id) || st.origin) === 'github') {
    const d = desiredCard(iss); const h = sha1(d);
    if (st.hash !== h) { await applyCardFromIssue(card, d); st.hash = h; changes++; console.log(`   ⬅︎ Card atualizado da issue #${num}`); }
  } else {
    const d = await desiredIssue(card); const h = sha1(d);
    if (st.hash !== h) { await applyIssueFromCard(iss, card, d); st.hash = h; changes++; console.log(`   ➡︎ Issue #${num} atualizada do card`); }
  }
}

// 2) Issues nativas -> novos cards
if (MIRROR) {
  for (const iss of allIssues) {
    if (iss.state !== 'open') continue;
    if (issueToCard.has(iss.number)) continue;               // já pareada
    if ((iss.body || '').includes('trello-sync:card=')) continue; // é trello-origin
    await createCardFromIssue(iss, state); changes++;
  }
}

// 3) Limpa pares órfãos (card deletado de vez) — não mexe na issue, só no estado
for (const cardId of Object.keys(state.pairs)) {
  if (!cardById.has(cardId)) delete state.pairs[cardId];
}

saveState(state);
console.log(changes ? `✨ Concluído. ${changes} alteração(ões).` : '✨ Concluído. Nada mudou.');
