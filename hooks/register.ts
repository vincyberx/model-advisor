import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Effort } from '../types'

const choice = atom({ plugin: 'model-advisor', key: 'choice' } as const, null)
const disabled = atom({ plugin: 'model-advisor', key: 'disabled' } as const, false)
const decided = atom({ plugin: 'model-advisor', key: 'decided' } as const, false)
const openers = atom({ plugin: 'model-advisor', key: 'openers' } as const, 0)
const lastLevel = atom({ plugin: 'model-advisor', key: 'lastLevel' } as const, null)
const seenEffort = atom({ plugin: 'model-advisor', key: 'seenEffort' } as const, null)
const floor = atom({ plugin: 'model-advisor', key: 'floor' } as const, null)

const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Below this size switching models is cheap: there is little to re-read.
const SMALL_CONTEXT = 40_000

// Above this level a subagent does not go without a person deciding it.
const MAX_SUBAGENT_LEVEL = 6
// An opening request up to this profile (a question, one command) is answered but does not
// fix the session's model: that waits for the first request that brings work, while the
// conversation is still short and switching costs little. So Haiku never becomes the
// model a working session is settled on.
const LIGHT_OPENER = 2
// A confirmation keeps the level in use, unless the previous request was this light:
// then "ok go ahead" may start heavier work than the level covers, and it is assessed.
const LOW_LEVEL = 3

type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
type Level = { model: string; effort: Effort; name: string }
type Lang = 'en' | 'it'
type Kind = 'request' | 'subagent'

// Eight model·effort profiles, from cheapest to most capable, set against Anthropic's
// documentation for the 5.5 models and Fable 5.2 and checked by the author on 30 real requests:
// 24 exact, 28 within one profile. Effort max is left out: it costs a lot and adds little.
export const LEVELS: Record<number, Level> = {
  1: { model: 'claude-haiku-5-5', effort: 'low', name: 'Haiku 5.5 · low' },
  2: { model: 'claude-haiku-5-5', effort: 'medium', name: 'Haiku 5.5 · medium' },
  3: { model: 'claude-sonnet-5-5', effort: 'medium', name: 'Sonnet 5.5 · medium' },
  4: { model: 'claude-sonnet-5-5', effort: 'high', name: 'Sonnet 5.5 · high' },
  5: { model: 'claude-opus-5-5', effort: 'medium', name: 'Opus 5.5 · medium' },
  6: { model: 'claude-opus-5-5', effort: 'high', name: 'Opus 5.5 · high' },
  7: { model: 'claude-opus-5-5', effort: 'xhigh', name: 'Opus 5.5 · xhigh' },
  8: { model: 'claude-fable-5-2', effort: 'high', name: 'Fable 5.2 · high' },
}

const STRENGTH: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

// Mid-session the model in use stays and only the effort moves: switching models makes
// Claude re-read the conversation without the cache. A stronger model covers the mechanical
// profiles (1-3) at low effort (Anthropic reports Opus 5.5 at low close to its default on
// several coding evaluations, at much lower cost). From profile 4 up the work asks for writing
// or reasoning, so it gets at least medium, and on Fable the judgment profiles get its default,
// high: Anthropic says to go below it only where evals show quality holds. A profile the model
// in use does not cover makes the mod propose a stronger model.
const EFFORT_ON_MODEL: Record<Family, Partial<Record<number, Effort>>> = {
  haiku: { 1: 'low', 2: 'medium' },
  sonnet: { 1: 'low', 2: 'low', 3: 'medium', 4: 'high' },
  opus: { 1: 'low', 2: 'low', 3: 'low', 4: 'medium', 5: 'medium', 6: 'high', 7: 'xhigh' },
  fable: { 1: 'low', 2: 'low', 3: 'low', 4: 'medium', 5: 'high', 6: 'high', 7: 'high', 8: 'high' },
}

// The most each model gives when the profile is above it: the "stay on this model"
// alternative, and a subagent's effort when its model was already chosen.
const TOP_EFFORT: Record<Family, Effort> = { haiku: 'high', sonnet: 'high', opus: 'xhigh', fable: 'high' }

// Subagents start without the conversation, so there the model is chosen at no cost.
// Only these types inherit the session's model: the others have a model chosen by
// whoever wrote them.
const GENERIC_SUBAGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude'])

// Prices and guidance from platform.claude.com/docs (pricing and effort pages),
// checked on 10 November 2026. Update them here, in both languages, when Anthropic changes them.
const FACTS: Record<Lang, string> = {
  en: `Facts from Anthropic's documentation (November 2026), prices per million input/output tokens:
- Haiku 5.5: $0.10/$0.50 (prompts over 100K tokens: $0.50/$2.50). Default effort medium; low suits chat, short tool tasks and simple requests.
- Sonnet 5.5: $2/$10. Default effort high. For agentic work, medium for well-specified tasks and high for harder or longer ones. For the hardest long-horizon work Anthropic points to Opus.
- Opus 5.5: $4/$20, strongest at multistep agentic work in a real repository. Default effort medium; on several coding evaluations low comes close to it at much lower cost. xhigh is for long-running work (over 30 minutes).
- Fable 5.2: $8/$40, the most capable model. Default effort high; xhigh only where a gain has been measured.
- xhigh and max only where they have been shown to help: thinking and replies get much longer.`,
  it: `Fatti dalla documentazione Anthropic (novembre 2026), prezzi per milione di token ingresso/uscita:
- Haiku 5.5: 0,10/0,50 $ (prompt oltre 100K token: 0,50/2,50). Effort predefinito medium; low va bene per chiacchiera, compiti brevi con strumenti e richieste semplici.
- Sonnet 5.5: 2/10 $. Effort predefinito high. Nel lavoro agentico, medium per i compiti ben definiti e high per quelli più difficili o lunghi. Per il lavoro lungo e più difficile Anthropic indica Opus.
- Opus 5.5: 4/20 $, il più forte nel lavoro agentico a più passi in un repository vero. Effort predefinito medium; in diverse valutazioni di coding low ci si avvicina a un costo molto più basso. xhigh è per il lavoro lungo (oltre 30 minuti).
- Fable 5.2: 8/40 $, il più capace. Effort predefinito high; xhigh solo dove il guadagno è misurato.
- xhigh e max solo dove hanno dimostrato di servire: ragionamento e risposte diventano molto più lunghi.`,
}

// The Italian scale is the one the 30 requests were measured on; a test holds the two
// to the same eight profiles.
export const SCALE: Record<Lang, string> = {
  en: `1 = Haiku 5.5 · low: greetings, small talk, thanks, questions about the conversation itself.
2 = Haiku 5.5 · medium: reading one fact or running one command and reporting it (disk space, a version, a service's status), summarising what was already said.
3 = Sonnet 5.5 · medium: mechanical steps with a known, already-decided procedure: commit and push files that are ready, add a line, rename, run an existing script.
4 = Sonnet 5.5 · high: everyday work with a clear scope that needs some writing or reasoning: update a note or document with content to synthesise, a small local configuration change, reorganise files with checks, answer a technical question by searching the project.
5 = Opus 5.5 · medium: work that needs judgment or touches things that are costly to get wrong: implementing a feature, writing new scripts, strategic advice, weighing options, operations on production projects (final audio or video, publishing, deploys, client accounts and data), configuration across several machines.
6 = Opus 5.5 · high: diagnosing something that does not work, destructive or irreversible operations in production (deleting services, data, volumes), long creative or technical work to do well unattended, checks where a mistake is expensive.
7 = Opus 5.5 · xhigh: very long autonomous work (over half an hour), several intermittent defects to understand together, ambiguous causes, architecture decisions, auditing a system.
8 = Fable 5.2 · high: only when Opus xhigh has already failed or the reasoning is exceptionally hard (deep research, open problems). Never for ordinary work.`,
  it: `1 = Haiku 5.5 · low: saluti, chiacchiera, ringraziamenti, domande sulla conversazione stessa.
2 = Haiku 5.5 · medium: un fatto da leggere o un comando da lanciare e riferire (spazio su disco, che versione è, stato di un servizio), un riassunto di cose già dette.
3 = Sonnet 5.5 · medium: operazioni meccaniche con procedura nota e già decisa: commit e push di file pronti, aggiungere una riga, rinominare, lanciare uno script esistente.
4 = Sonnet 5.5 · high: lavoro quotidiano con perimetro chiaro che chiede di scrivere o ragionare un po': aggiornare una nota o un documento con contenuto da sintetizzare, una piccola modifica di configurazione locale, riordinare file con verifiche, rispondere a una domanda tecnica cercando nel progetto.
5 = Opus 5.5 · medium: lavoro che chiede giudizio o tocca cose che costano se sbagliate: implementare una funzionalità, scrivere script nuovi, consigli strategici, valutare opzioni, operazioni su progetti in produzione (audio o video definitivi, pubblicazioni, deploy, account e dati dei clienti), configurazioni su più macchine.
6 = Opus 5.5 · high: diagnosi di qualcosa che non funziona, operazioni distruttive o irreversibili in produzione (cancellare servizi, dati, volumi), lavori creativi o tecnici lunghi da fare bene in autonomia, verifiche dove un errore costa caro.
7 = Opus 5.5 · xhigh: lavori autonomi molto lunghi (oltre mezz'ora), più difetti intermittenti da capire insieme, cause ambigue, decisioni di architettura, audit di un sistema.
8 = Fable 5.2 · high: solo quando anche Opus xhigh ha fallito o il ragionamento è eccezionalmente difficile (ricerca profonda, problemi aperti). Mai per lavoro ordinario.`,
}

const FORMAT: Record<Lang, string> = {
  en: `Answer ONLY with JSON, no other text: {"profile": <1-8>, "reason": "<at most 12 words>", "ultracode": <true|false>}`,
  it: `Rispondi SOLO con JSON, senza altro testo: {"profilo": <1-8>, "motivo": "<massimo 12 parole>", "ultracode": <true|false>}`,
}

// Requests also say whether they correct the work just done: logged as a sign that the
// level in use was too little.
const REQUEST_FORMAT: Record<Lang, string> = {
  en: `Answer ONLY with JSON, no other text: {"profile": <1-8>, "reason": "<at most 12 words>", "ultracode": <true|false>, "correction": <true|false>}`,
  it: `Rispondi SOLO con JSON, senza altro testo: {"profilo": <1-8>, "motivo": "<massimo 12 parole>", "ultracode": <true|false>, "correzione": <true|false>}`,
}

// `own` is the person's note about their work (the `context` option), or nothing.
const INSTRUCTIONS: Record<Lang, (own: string) => string> = {
  en: own => `You advise Claude Code on model and effort. Claude Code is the assistant that works on the user's machines with a shell, files, git, the web and connected tools. You receive the request the user is about to send, with an excerpt of what was happening before. Pick the CHEAPEST profile that does the job right the first time: redoing botched work costs more than the right model.

${FACTS.en}

The profiles:
${SCALE.en}
${own}
Rules:
- Judge the work the request sets in motion, not the length of the text: "ok go ahead" weighs as much as the work proposed just before it in the excerpt.
- When a request sits between two profiles, pick the higher one: too little means work to redo, too much costs a few tokens.
- Requests can be in any language, often typed in a hurry and with typos.
- "ultracode": true only if the request asks for an audit or a broad review of a whole system or repository, where several agents in parallel are needed; otherwise false.
- "correction": true only if the request says the work just done is wrong, incomplete or has to be redone; otherwise false.

${REQUEST_FORMAT.en}`,
  it: own => `Sei il consigliere di modello ed effort per Claude Code, l'assistente che lavora sulle macchine dell'utente con shell, file, git, web e strumenti collegati. Ricevi la richiesta che l'utente sta per mandare, con un estratto di cosa stava succedendo prima. Scegli il profilo PIÙ ECONOMICO che fa bene il lavoro al primo colpo: rifare un lavoro rovinato costa più del modello giusto.

${FACTS.it}

I profili:
${SCALE.it}
${own}
Regole:
- Giudica il lavoro che la richiesta mette in moto, non la lunghezza del testo: "ok procedi" vale quanto il lavoro proposto subito prima nell'estratto.
- Quando una richiesta sta tra due profili, scegli il più alto: troppo poco vuol dire lavoro da rifare, troppo costa pochi token.
- Le richieste possono essere in qualsiasi lingua, spesso scritte in fretta e con refusi.
- "ultracode": true solo se la richiesta chiede un audit o una revisione ampia di un intero sistema o repo, dove servono più agenti in parallelo; altrimenti false.
- "correzione": true solo se la richiesta dice che il lavoro appena fatto è sbagliato, incompleto o da rifare; altrimenti false.

${REQUEST_FORMAT.it}`,
}

const SUBAGENT_INSTRUCTIONS: Record<Lang, (own: string) => string> = {
  en: own => `You advise Claude Code on model and effort. You receive the brief a Claude Code session wrote for a subagent: a self-contained assignment the subagent carries out without seeing the conversation it comes from. Estimate only the work the brief describes and pick the CHEAPEST profile that does it right the first time. Searching, reading and listing files is cheap even when the brief is long; what counts is the judgment required and how much a mistake costs.

${FACTS.en}

The profiles:
${SCALE.en}
${own}
"ultracode" is always false for a subagent.
${FORMAT.en}`,
  it: own => `Sei il consigliere di modello ed effort per Claude Code. Ricevi il brief che una sessione di Claude Code ha scritto per un sotto-agente: un incarico autonomo, che il sotto-agente esegue senza vedere la conversazione da cui nasce. Stima solo il lavoro descritto nel brief e scegli il profilo PIÙ ECONOMICO che lo fa bene al primo colpo. Cercare, leggere ed elencare file costa poco anche quando il brief è lungo; contano il giudizio richiesto e quanto costa un errore.

${FACTS.it}

I profili:
${SCALE.it}
${own}
"ultracode" è sempre false per un sotto-agente.
${FORMAT.it}`,
}

// At the top of the main session's prompt: whoever orchestrates knows the work it
// delegates better than any classifier, so it picks the model itself.
const ORCHESTRATOR_GUIDE: Record<Lang, string> = {
  en: `# Model for subagents and sessions
When you launch a generic subagent (Agent tool) or start a session (start_session), choose the model yourself with the \`model\` parameter, based on the work you hand over: Haiku to search, read, list and summarise; Sonnet for work with a clear scope; Opus for judgment, implementation, diagnosis and production operations. Take the cheapest one that does the job right the first time. The subagent's effort is set by the model-advisor mod.`,
  it: `# Modello per sotto-agenti e sessioni
Quando lanci un sotto-agente generico (tool Agent) o avvii una sessione (start_session), scegli tu il modello con il parametro \`model\`, in base al lavoro che affidi: Haiku per cercare, leggere, elencare e riassumere; Sonnet per lavoro con perimetro chiaro; Opus per giudizio, implementazione, diagnosi e operazioni in produzione. Prendi il più economico che fa bene il lavoro al primo colpo. L'effort del sotto-agente lo regola il mod model-advisor.`,
}

// Who chose a subagent's model, as the log records it.
const BY_SESSION = 'model chosen by the session'
const BY_MOD = 'chosen by the mod'

// What the mod says around the request to the classifier, to the model in use and to
// the person. The log's outcomes stay in English in both languages, so one script reads them.
type Texts = {
  own: string
  before: (excerpt: string) => string
  previous: (level: number) => string
  asked: (question: string) => string
  request: string
  brief: string
  modelNote: (name: string, id: string, effort: Effort) => string
  status: (inUse: string, session: string | null) => string
  recommend: (name: string, reason: string) => string
  stronger: (name: string, reason: string, cost: string) => string
  cheap: string
  reread: (thousands: number) => string
  which: string
  header: string
  take: (name: string) => string
  alternative: (name: string) => string
  wider: (name: string) => string
  widerHint: string
  keep: (name: string) => string
  stop: string
  stopped: string
  ultracode: string
  subagent: (description: string, name: string, bySession: boolean, reason: string) => string
  command: string
  off: string
  on: string
  reset: string
  state: (state: 'mods' | 'off' | 'on', level: string | null, log: string) => string
}

const TEXTS: Record<Lang, Texts> = {
  en: {
    own: 'A note from the person using Claude Code about their own work and tools:',
    before: excerpt => `Excerpt of what was happening before (end of the assistant's last reply):\n«${excerpt}»\n\n`,
    asked: question => `The assistant then asked the user: «${question}»\n\n`,
    previous: level => `The previous request was profile ${level}: take it into account only if this one continues it.\n\n`,
    request: "The user's request",
    brief: "The subagent's brief",
    modelNote: (name, id, effort) =>
      `The model-advisor mod, installed by the user, picked the model for this request: ` +
      `it runs on ${name} (ID ${id}), effort ${effort}. The system prompt still names ` +
      `the session's model because it was composed before the choice; it updates from the next turn. ` +
      `For the model's name and for Co-Authored-By lines, this note applies.`,
    status: (inUse, session) => `In use: ${inUse}${session ? ` (session: ${session})` : ''}`,
    recommend: (name, reason) => `For this request I recommend ${name}${reason}.`,
    stronger: (name, reason, cost) => `This request needs a stronger model: I recommend ${name}${reason}. ${cost}`,
    cheap: 'The conversation is still short: switching now is cheap.',
    reread: thousands =>
      `Switching models now makes Claude re-read the whole conversation (about ${thousands}k tokens) without the cache.`,
    which: 'Which one?',
    header: 'Level',
    take: name => `${name} (recommended)`,
    alternative: name => `${name} (same model)`,
    wider: name => `${name} for the whole session`,
    widerHint: 'If heavier work follows, Opus avoids a model switch later.',
    keep: name => `Keep ${name}`,
    stop: 'Stop asking in this session',
    stopped: 'Advice off for this session: /model-advisor on turns it back on',
    ultracode: 'For an audit this broad, ultracode helps: add it to the request to work with several agents.',
    subagent: (description, name, bySession, reason) =>
      `subagent «${description}» on ${name}, ${bySession ? BY_SESSION : BY_MOD}${reason}`,
    command: 'Model and effort advice: on, off, reset (back to the session level)',
    off: 'Advice off for this session.',
    on: 'Advice on: I set the effort myself and ask only to switch models.',
    reset: "Back to the session's model and effort.",
    state: (state, level, log) =>
      `Advice ${{ mods: 'off from /mods', off: 'off', on: 'on' }[state]}. Level in use: ${level ?? "the session's"}. Commands: /model-advisor on | off | reset. To skip one request, start it with ~. Decision log: ${log}`,
  },
  it: {
    own: 'Nota di chi usa Claude Code sul proprio lavoro e i propri strumenti:',
    before: excerpt => `Estratto di cosa succedeva prima (fine dell'ultima risposta dell'assistente):\n«${excerpt}»\n\n`,
    asked: question => `Poi l'assistente ha chiesto all'utente: «${question}»\n\n`,
    previous: level => `La richiesta precedente era di profilo ${level}: tienine conto solo se questa la continua.\n\n`,
    request: "Richiesta dell'utente",
    brief: 'Brief del sotto-agente',
    modelNote: (name, id, effort) =>
      `Il mod model-advisor, installato dall'utente, ha scelto il modello per questa richiesta: ` +
      `gira su ${name} (ID ${id}), effort ${effort}. Il prompt di sistema nomina ancora ` +
      `il modello della sessione perché è stato composto prima della scelta; si aggiorna dal turno successivo. ` +
      `Per il nome del modello e per le righe Co-Authored-By vale questa nota.`,
    status: (inUse, session) => `In uso: ${inUse}${session ? ` (sessione: ${session})` : ''}`,
    recommend: (name, reason) => `Per questa richiesta consiglio ${name}${reason}.`,
    stronger: (name, reason, cost) =>
      `Per questa richiesta serve un modello più forte: consiglio ${name}${reason}. ${cost}`,
    cheap: 'La conversazione è ancora corta: cambiare adesso costa poco.',
    reread: thousands =>
      `Cambiare modello adesso fa rileggere tutta la conversazione (circa ${thousands}k token) senza cache.`,
    which: 'Quale uso?',
    header: 'Livello',
    take: name => `${name} (consigliato)`,
    alternative: name => `${name} (stesso modello)`,
    wider: name => `${name} per tutta la sessione`,
    widerHint: 'Se dopo arriva lavoro più pesante, Opus evita un cambio di modello a metà.',
    keep: name => `Tieni ${name}`,
    stop: 'Non chiedere più qui',
    stopped: 'Consigli spenti per questa sessione: /model-advisor on per riaccenderli',
    ultracode: 'Per un audit così ampio conviene ultracode: aggiungilo alla richiesta per lavorare con più agenti.',
    subagent: (description, name, bySession, reason) =>
      `sotto-agente «${description}» su ${name}, ${bySession ? 'modello scelto dalla sessione' : 'scelto dal mod'}${reason}`,
    command: 'Consiglio di modello ed effort: on, off, reset (torna al livello della sessione)',
    off: 'Consigli spenti per questa sessione.',
    on: "Consigli accesi: regolo l'effort da solo e chiedo solo per cambiare modello.",
    reset: "Torno al modello e all'effort della sessione.",
    state: (state, level, log) =>
      `Consigli ${{ mods: 'spenti da /mods', off: 'spenti', on: 'accesi' }[state]}. Livello in uso: ${level ?? 'quello della sessione'}. Comandi: /model-advisor on | off | reset. Per saltare una richiesta, iniziala con ~. Registro delle decisioni: ${log}`,
  },
}

// The person's note reaches the classifier on every request: this caps what it costs.
const OWN_CONTEXT_MAX = 1000

// The options, as this activation received them. With "auto" the texts follow the
// language Claude Code is set to (the `language` row of /config): Italian, or English.
let languageOption = 'auto'
let language: Lang | null = null
let ownContext = ''

export function isItalian(value: unknown): boolean {
  return typeof value === 'string' && /^(it|it[-_].*|ital.*)$/i.test(value.trim())
}

async function lang($: EngineInterface): Promise<Lang> {
  if (language !== null) {
    return language
  }
  if (languageOption === 'it' || languageOption === 'en') {
    language = languageOption

    return language
  }
  try {
    const row = (await $.config.list()).find(r => r.key === 'language')
    language = isItalian(row?.value) ? 'it' : 'en'

    return language
  } catch {
    return 'en' // not kept: the next request asks again
  }
}

// A short confirmation continues the work already under way: it keeps the level in use.
const CONFIRMATION_WORDS = new Set([
  'ok', 'okay', 'k', 'yes', 'yep', 'yeah', 'sure', 'right', 'exactly', 'confirmed', 'agreed',
  'go', 'ahead', 'on', 'proceed', 'continue', 'carry', 'do', 'it', 'please', 'fine', 'good',
  'great', 'perfect', 'thanks', 'thank', 'you', 'done', 'all', 'and', 'then', 'that', 'sounds',
  // Italian
  'oki', 'okk', 'si', 'sì', 'certo', 'esatto', 'giusto', 'confermo', 'procedi', 'procediamo',
  'prosegui', 'proseguiamo', 'continua', 'continuiamo', 'avanti', 'vai', 'va', 'bene', 'benissimo',
  'perfetto', 'ottimo', 'top', 'fatto', 'fai', 'pure', 'chiudi', 'chiudiamo', 'tutto', 'tu',
  'allora', 'e', 'dai', 'grazie', "d'accordo", 'daccordo',
  // Spanish, French, German
  'sí', 'oui', 'merci', 'vas-y', 'ja', 'danke',
])

type Advice = { level: number; reason: string; ultracode?: boolean; correction?: boolean }

export function isConfirmation(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.includes('?')) {
    return false
  }
  const words = t.replace(/[.,;:!…]/g, ' ').split(/\s+/).filter(Boolean)

  return words.length > 0 && words.length <= 6 && words.every(w => CONFIRMATION_WORDS.has(w))
}

export function parseAdvice(answer: string): Advice | null {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end < start) {
    return null
  }
  try {
    const j = JSON.parse(answer.slice(start, end + 1))
    const level = Number(j.profile ?? j.profilo ?? j.level)
    if (!Number.isInteger(level) || !LEVELS[level]) {
      return null
    }

    const reason = j.reason ?? j.motivo

    const correction = (j.correction ?? j.correzione) === true

    return {
      level,
      reason: typeof reason === 'string' ? reason.trim() : '',
      ultracode: j.ultracode === true,
      ...(correction ? { correction } : {}),
    }
  } catch {
    return null
  }
}

function family(id: string): Family {
  const f = /(haiku|sonnet|opus|fable)/.exec(id.toLowerCase())?.[1]

  return (f as Family | undefined) ?? 'opus'
}

function modelName(id: string): string {
  const [, fam, major, minor] = /(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?/.exec(id.toLowerCase()) ?? []
  if (!fam || !major) {
    const alias = /(haiku|sonnet|opus|fable)/.exec(id.toLowerCase())?.[1]

    return alias ? `${alias.charAt(0).toUpperCase()}${alias.slice(1)}` : id
  }

  return `${fam.charAt(0).toUpperCase()}${fam.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

function levelName(model: string, effort: Effort | null): string {
  return effort ? `${modelName(model)} · ${effort}` : modelName(model)
}

function levelOn(model: string, effort: Effort): Level {
  return { model, effort, name: levelName(model, effort) }
}

function asEffort(effort: unknown): Effort | null {
  return typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
    ? (effort as Effort)
    : null
}

/**
 * What to propose. On the session's first request, the level's model and effort.
 * After that, the effort on the model in use, and a different model only if the
 * one in use is weaker than the work needs.
 */
export function propose(level: number, modelInUse: string, firstRequest: boolean) {
  const ofLevel = LEVELS[level]
  if (!ofLevel) {
    return null
  }
  if (firstRequest) {
    return { recommended: ofLevel, alternative: null, switchesModel: false }
  }
  const fam = family(modelInUse)
  const effort = EFFORT_ON_MODEL[fam][level]
  if (effort && STRENGTH[family(ofLevel.model)] <= STRENGTH[fam]) {
    return { recommended: levelOn(modelInUse, effort), alternative: null, switchesModel: false }
  }

  return { recommended: ofLevel, alternative: levelOn(modelInUse, TOP_EFFORT[fam]), switchesModel: true }
}

async function assess(
  $: EngineInterface,
  text: string,
  kind: Kind,
  previous: number | null = null,
  before = '',
  asked = '',
): Promise<Advice | null> {
  const l = await lang($)
  const t = TEXTS[l]
  const own = ownContext ? `\n${t.own}\n${ownContext}\n` : ''
  const context =
    (before ? t.before(before) : '') + (asked ? t.asked(asked) : '') + (previous === null ? '' : t.previous(previous))
  try {
    const r = await $.model.complete({
      model: 'sonnet',
      system: (kind === 'request' ? INSTRUCTIONS : SUBAGENT_INSTRUCTIONS)[l](own),
      prompt: `${context}${kind === 'request' ? t.request : t.brief}:\n"""\n${text.slice(0, 1500)}\n"""`,
      effort: 'low',
      maxTokens: 300,
      timeoutMs: 20_000,
    })
    if (!r.isAnswered) {
      $.ui.log(`no advice (${r.reason})`, { to: 'debug' })

      return null
    }

    return parseAdvice(r.text)
  } catch (err) {
    $.ui.log(`assessment failed (${String(err)})`, { to: 'debug' })

    return null
  }
}

// The end of the last reply: "ok go ahead" weighs as much as the work it approves.
async function lastReply($: EngineInterface): Promise<string> {
  try {
    const messages = await $.session.messages()
    const last = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())

    return last ? last.text.trim().slice(-800) : ''
  } catch {
    return ''
  }
}

// A question put to the user through a tool (a dialog, a next-step box) is not in the
// reply's text: without it "yes, add them" has nothing to refer to.
function questionIn(input: Record<string, unknown>): string {
  if (typeof input.ask === 'string') {
    return input.ask
  }
  const questions = Array.isArray(input.questions) ? input.questions : []

  return questions
    .map(q => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : ''))
    .filter(Boolean)
    .join(' ')
}

// The last question asked since the user's previous message, or ''.
async function lastQuestion($: EngineInterface): Promise<string> {
  try {
    const messages = await $.session.messages()
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || (m.role === 'user' && m.text.trim())) {
        break
      }
      for (const use of [...(m.toolUses ?? [])].reverse()) {
        const question = questionIn(use.input ?? {}).trim()
        if (question) {
          return question.replace(/\s+/g, ' ').slice(0, 300)
        }
      }
    }
  } catch {
    // No transcript: the excerpt alone.
  }

  return ''
}

function inParens(reason: string): string {
  return reason ? ` (${reason.replace(/\.$/, '')})` : ''
}

export function lowers(next: Effort, current: Effort | null): boolean {
  return current !== null && EFFORT_ORDER.indexOf(next) < EFFORT_ORDER.indexOf(current)
}

async function apply(
  $: EngineInterface,
  level: number,
  chosen: Level,
  sessionModel: string,
  sessionEffort: Effort | null,
) {
  const before = await read($, choice)
  const asSession = sameModel(chosen.model, sessionModel) && chosen.effort === sessionEffort
  const next: Choice | null = asSession ? null : { level, ...chosen, sessionModel, sessionEffort }
  await update($, choice, () => next)
  $.ui.status(next ? statusText(next, await lang($)) : undefined)
  if ((before?.model ?? sessionModel) !== (next?.model ?? sessionModel)) {
    // The model's name sits in a system prompt section: from the next turn prompt.section rewrites it.
    $.ui.invalidate('prompt.section')
  }
}

// The app's own selector keeps showing the session's model and effort: the line says
// what is running in their place, and names only what differs.
function statusText(c: Choice, l: Lang): string {
  return sameModel(c.model, c.sessionModel)
    ? TEXTS[l].status(`effort ${c.effort}`, c.sessionEffort)
    : TEXTS[l].status(c.name, modelName(c.sessionModel))
}

function direction(c: Choice, model: string, effort: Effort | null): 'raised' | 'lowered' | 'changed' {
  const byModel = STRENGTH[family(model)] - STRENGTH[family(c.model)]
  const by = byModel || (effort ? EFFORT_ORDER.indexOf(effort) - EFFORT_ORDER.indexOf(c.effort) : 0)

  return by > 0 ? 'raised' : by < 0 ? 'lowered' : 'changed'
}

function sameModel(a: string, b: string): boolean {
  return modelName(a) === modelName(b)
}

function modelChanged(c: Choice | null): c is Choice {
  return c !== null && !sameModel(c.model, c.sessionModel)
}

// This turn's system prompt is already composed and names the session's model:
// without an explanation the model trusts the prompt.
function modelNote(c: Choice, l: Lang): string {
  return TEXTS[l].modelNote(modelName(c.model), c.model, c.effort)
}

export function effortOn(model: string, level: number): Effort {
  const fam = family(model)

  return EFFORT_ON_MODEL[fam][level] ?? TOP_EFFORT[fam]
}

// Claude Code's config folder (CLAUDE_CONFIG_DIR, or ~/.claude), read once per load.
let configDir: string | null = null

async function claudeDir($: EngineInterface): Promise<string> {
  if (configDir === null) {
    let dir = ''
    try {
      const r = await $.process.run(['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'])
      dir = r.stdout.trim()
    } catch {
      // Falls back to the folder the plugin is installed under.
    }
    configDir = dir || `${$.plugin.root.split('/.claude/')[0] ?? ''}/.claude`
  }

  return configDir
}

// The /mods panel turns the mod off in every chat by writing "model-advisor": false
// to switches.json. Re-read at most every 3 seconds.
let offInModsCached = false
let readAt = -Infinity

async function offInMods($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  if (now - readAt < 3000) {
    return offInModsCached
  }
  readAt = now
  try {
    const path = `${await claudeDir($)}/mods/switches.json`
    const json = (await $.fs.exists(path)) ? (JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>) : {}
    offInModsCached = json['model-advisor'] === false
  } catch {
    // A broken or missing file changes nothing.
  }

  return offInModsCached
}

async function enabled($: EngineInterface): Promise<boolean> {
  return !(await read($, disabled)) && !(await offInMods($))
}

async function someoneWatching($: EngineInterface): Promise<boolean> {
  return (await enabled($)) && (await $.session.surfaces()).length > 0
}

async function decide(
  $: EngineInterface,
  advice: Advice,
  firstRequest: boolean,
  sessionModel: string,
  sessionEffort: Effort | null,
): Promise<string> {
  const current = await read($, choice)
  const inUse = current
    ? { model: current.model, effort: current.effort as Effort | null }
    : { model: sessionModel, effort: sessionEffort }
  const previous = await read($, lastLevel)
  await update($, lastLevel, () => advice.level)

  if (firstRequest && advice.level === 1) {
    // A greeting does not say yet what the work will be: the model is decided later.
    await update($, openers, n => n + 1)

    return 'greeting: model not decided yet'
  }
  if (firstRequest && advice.level <= LIGHT_OPENER) {
    await update($, openers, n => n + 1)
  } else if (firstRequest) {
    await update($, decided, () => true)
  }

  const proposed = propose(advice.level, inUse.model, firstRequest)
  if (!proposed) {
    return `stays on ${levelName(inUse.model, inUse.effort)}`
  }
  // "Keep" is a choice: on that model the effort may go up, not below what was kept.
  const min = await read($, floor)
  const held =
    min?.effort && sameModel(min.model, inUse.model) && sameModel(proposed.recommended.model, inUse.model) && lowers(proposed.recommended.effort, min.effort)
      ? min.effort
      : null
  const p = held ? { ...proposed, recommended: levelOn(inUse.model, held) } : proposed
  if (sameModel(p.recommended.model, inUse.model) && p.recommended.effort === inUse.effort) {
    return `stays on ${levelName(inUse.model, inUse.effort)}${held ? ': not below the level you kept' : ''}`
  }

  if (sameModel(p.recommended.model, inUse.model) || (!firstRequest && !p.switchesModel)) {
    // Only the effort, on the model in use: it costs nothing, so it applies itself with
    // no question. It goes up at once; it comes down only if the previous request was
    // light too, so a quick question in the middle of heavy work does not deflate it.
    if (lowers(p.recommended.effort, inUse.effort) && previous !== null && previous > advice.level) {
      return `stays on ${levelName(inUse.model, inUse.effort)}: effort drops only after two light requests`
    }
    await apply($, advice.level, p.recommended, sessionModel, sessionEffort)

    return `auto: ${levelName(inUse.model, inUse.effort)} → ${p.recommended.name}`
  }

  const t = TEXTS[await lang($)]
  const reason = inParens(advice.reason)
  let question = t.recommend(p.recommended.name, reason)
  if (p.switchesModel) {
    const context = (await $.session.usage()).context.tokens ?? 0
    const cost = context < SMALL_CONTEXT ? t.cheap : t.reread(Math.round(context / 1000))
    question = t.stronger(p.recommended.name, reason, cost)
  }

  // The request that settles the session is often a preparatory step ("check", "read")
  // lighter than what follows. When it would settle on Sonnet, Opus is offered too, at the
  // effort this request needs: whoever knows heavier work is coming avoids a switch later.
  const opus = LEVELS[5]?.model
  const widerLevel =
    opus && firstRequest && advice.level > LIGHT_OPENER && family(p.recommended.model) === 'sonnet' && family(inUse.model) !== 'opus'
      ? levelOn(opus, effortOn(opus, advice.level))
      : null
  if (widerLevel) {
    question = `${question} ${t.widerHint}`
  }

  const take = t.take(p.recommended.name)
  const alternative = p.alternative ? t.alternative(p.alternative.name) : null
  const wider = widerLevel ? t.wider(widerLevel.name) : null
  const keep = t.keep(levelName(inUse.model, inUse.effort))
  const stop = t.stop
  const options = [take, ...(alternative ? [alternative] : []), ...(wider ? [wider] : []), keep, stop]

  let answer: string
  try {
    answer = await $.ui.ask(`${question} ${t.which}`, { options, header: t.header })
  } catch {
    return `question for ${p.recommended.name} closed unanswered: stays on ${levelName(inUse.model, inUse.effort)}`
  }

  const chosen = answer === take ? p.recommended : answer === alternative ? p.alternative : answer === wider ? widerLevel : null
  if (chosen) {
    await apply($, advice.level, chosen, sessionModel, sessionEffort)

    return `question for ${p.recommended.name}: chose ${chosen.name}`
  }
  if (answer === stop) {
    await update($, disabled, () => true)
    $.ui.toast(t.stopped)

    return `question for ${p.recommended.name}: advice turned off`
  }

  // The effort is not known before the session's first step: turn.step fills it in.
  await update($, floor, () => ({ model: inUse.model, effort: inUse.effort }))

  return `question for ${p.recommended.name}: kept ${levelName(inUse.model, inUse.effort)}`
}

// One line per decision in <config dir>/mods/model-advisor/<session>.jsonl, to read back
// what the mod estimated and why. One file per session: $.fs cannot append, and this way
// two chats do not overwrite each other.
let folderReady = false

async function record(
  $: EngineInterface,
  entry: {
    kind: 'request' | 'subagent' | 'session'
    text: string
    level?: number
    reason?: string
    outcome: string
    // Set when the request corrects the work just done: the level that work ran on.
    corrects?: string
  },
) {
  try {
    const folder = `${await claudeDir($)}/mods/model-advisor`
    if (!folderReady) {
      await $.process.run(['mkdir', '-p', folder])
      folderReady = true
    }
    const path = `${folder}/${await $.session.id()}.jsonl`
    const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const line = {
      time: new Date(await $.clock.now()).toISOString(),
      cwd: await $.session.cwd(),
      ...entry,
      text: entry.text.replace(/\s+/g, ' ').slice(0, 160),
    }
    await $.fs.write(path, `${before}${JSON.stringify(line)}\n`)
  } catch (err) {
    $.ui.log(`log not written (${String(err)})`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  languageOption = String(options.language ?? 'auto')
  language = null
  ownContext = String(options.context ?? '').trim().slice(0, OWN_CONTEXT_MAX)

  // The effort chosen for each subagent, applied to each of its steps.
  const subagentEffort = new Map<string, Effort>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-advisor',
      description: TEXTS[await lang($)].command,
    })

    return next(e)
  })

  on('command.run', { command: 'model-advisor' }, async ($, e) => {
    const t = TEXTS[await lang($)]
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await update($, disabled, () => true)

      return { text: t.off }
    }
    if (arg === 'on') {
      await update($, disabled, () => false)

      return { text: t.on }
    }
    if (arg === 'reset') {
      const c = await read($, choice)
      await update($, choice, () => null)
      await update($, floor, () => null)
      $.ui.status(undefined)
      if (modelChanged(c)) {
        $.ui.invalidate('prompt.section')
      }

      return { text: t.reset }
    }
    const c = await read($, choice)
    const state = (await offInMods($)) ? 'mods' : (await read($, disabled)) ? 'off' : 'on'
    const log = `${await claudeDir($)}/mods/model-advisor/${await $.session.id()}.jsonl`

    return { text: t.state(state, c ? c.name : null, log) }
  })

  on('prompt.submit', async ($, e, next) => {
    // Only requests typed by a person who is watching: no commands, notifications,
    // other sessions, or prompts typed while a turn is running.
    const byPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (e.command || e.isMeta || e.turnId || !byPerson || !(await someoneWatching($))) {
      return next(e) // nobody to ask, as under claude -p
    }

    const text = e.text.trim()
    if (text.startsWith('~')) {
      await update($, decided, () => true) // whoever skips the advice has already chosen the level
      await record($, { kind: 'request', text, outcome: 'skipped with ~' })

      return next({ ...e, text: text.replace(/^~\s*/, '') })
    }
    const undecided = !(await read($, decided))
    const last = await read($, lastLevel)
    if (isConfirmation(text) && (last === null || last > LOW_LEVEL)) {
      if (undecided) {
        await update($, openers, n => n + 1)
      }
      await record($, { kind: 'request', text, outcome: 'confirmation: level in use kept' })

      return next(e)
    }

    // Decided here, before the turn starts, so the model can be told which model it is.
    // The "first request" is the first one that brings work: opening greetings do not count.
    const firstRequest = undecided && (await $.session.turns()) <= (await read($, openers))
    const before = await read($, choice)
    const sessionModel = await $.session.model()
    const advice = await assess($, text, 'request', last, await lastReply($), await lastQuestion($))
    if (advice?.ultracode && !/ultracode/i.test(text)) {
      $.ui.toast(TEXTS[await lang($)].ultracode)
    }
    const outcome = advice
      ? await decide($, advice, firstRequest, sessionModel, await read($, seenEffort))
      : 'no estimate: level in use kept'
    await record($, {
      kind: 'request',
      text,
      level: advice?.level,
      reason: advice?.reason,
      outcome: advice?.ultracode ? `${outcome}; ultracode suggested` : outcome,
      ...(advice?.correction ? { corrects: before?.name ?? levelName(sessionModel, await read($, seenEffort)) } : {}),
    })
    const after = await read($, choice)
    if (modelChanged(after) && after.model !== before?.model) {
      return next({ ...e, context: [...(e.context ?? []), modelNote(after, await lang($))] })
    }

    return next(e)
  }).catch((_, e, next) => next(e)) // if the mod fails, the request goes through anyway

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.surfaces.length === 0 || !(await enabled($))) {
      return r
    }

    return { sections: [...r.sections, { id: 'model-advisor:orchestrate', text: ORCHESTRATOR_GUIDE[await lang($)], scope: 'session' }] }
  }).catch((_, e, next) => next(e))

  on('prompt.section', { name: 'env_info_model' }, async ($, e, next) => {
    const r = await next(e)
    const c = await read($, choice)
    if (!r.text || !modelChanged(c) || (await offInMods($))) {
      return r
    }

    return {
      text: r.text.split(modelName(c.sessionModel)).join(modelName(c.model)).split(c.sessionModel).join(c.model),
    }
  }).catch((_, e, next) => next(e))

  on('attribution.text', async ($, e, next) => {
    const r = await next(e)
    const c = await read($, choice)
    if (!modelChanged(c) || (await offInMods($))) {
      return r
    }

    return { text: r.text.split(modelName(c.sessionModel)).join(modelName(c.model)) }
  }).catch((_, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const generic = !e.fork && !e.resume && !e.workflow && !e.isTeammate && GENERIC_SUBAGENTS.has(e.subagentType)
    if (!generic || !(await someoneWatching($))) {
      return next(e) // a type with its own model, or nobody watching
    }
    const advice = await assess($, e.prompt, 'subagent')
    if (!advice) {
      return next(e)
    }
    // If the orchestrator chose the model its choice stands: the mod adds the effort.
    const level = Math.min(advice.level, MAX_SUBAGENT_LEVEL)
    const fromMod = LEVELS[level]
    const model = e.model ?? fromMod?.model
    if (!model) {
      return next(e)
    }
    const effort = e.model ? effortOn(e.model, level) : (fromMod?.effort ?? 'medium')

    const started = await next(e.model ? e : { ...e, model })
    if (!started.deny && started.agentId) {
      subagentEffort.set(started.agentId, effort)
      const reason = inParens(advice.reason)
      $.ui.log(TEXTS[await lang($)].subagent(e.description, levelName(model, effort), !!e.model, reason))
      await record($, {
        kind: 'subagent',
        text: `${e.description}: ${e.prompt}`,
        level: advice.level,
        reason: advice.reason,
        outcome: `${levelName(model, effort)}, ${e.model ? BY_SESSION : BY_MOD}`,
      })
    }

    return started
  }).catch((_, e, next) => (next.called ? undefined : next(e)))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const effort = subagentEffort.get(e.agentId)

      return yield* next(effort ? { ...e, effort } : e)
    }
    const sessionEffort = asEffort(e.effort)
    const seen = await read($, seenEffort)
    if (seen !== sessionEffort) {
      await update($, seenEffort, () => sessionEffort)
    }

    const c = await read($, choice)
    if (!c) {
      const min = await read($, floor)
      if (min && min.effort === null && sameModel(min.model, e.model)) {
        // "Keep" was answered before the session's effort was known.
        await update($, floor, () => ({ model: min.model, effort: sessionEffort }))
      } else if (min && seen !== null && seen !== sessionEffort) {
        // The effort was set with /effort: that is the level now, the kept one no longer holds.
        await update($, floor, () => null)
      }

      return yield* next(e)
    }
    if (await offInMods($)) {
      // Off from /mods: back to the session's level until it is turned on again.
      $.ui.status(undefined)

      return yield* next(e)
    }
    if (!sameModel(c.sessionModel, e.model) || (c.sessionEffort !== null && c.sessionEffort !== sessionEffort)) {
      // The session's model or effort changed with /model or /effort: that choice wins.
      // Logged with its direction: a raise says the mod's level was too little.
      await update($, floor, () => null)
      await record($, {
        kind: 'session',
        text: '',
        outcome: `session set to ${levelName(e.model, sessionEffort)} over ${c.name}: ${direction(c, e.model, sessionEffort)}`,
      })
      await update($, choice, () => null)
      $.ui.status(undefined)
      $.ui.invalidate('prompt.section')

      return yield* next(e)
    }
    if (c.sessionEffort === null) {
      // On the first request the session's effort was not known yet.
      await update($, choice, v => (v ? { ...v, sessionEffort } : v))
      // Now that it is known, a choice equal to the session needs no line.
      const asSession = sameModel(c.model, c.sessionModel) && c.effort === sessionEffort
      $.ui.status(asSession ? undefined : statusText({ ...c, sessionEffort }, await lang($)))
    }

    return yield* next({ ...e, model: c.model, effort: c.effort })
  }).catch(async function* (_, e, next) {
    return yield* next(e)
  })
}
