import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Choice, Effort } from '../types'

const choice = atom({ plugin: 'model-advisor', key: 'choice' } as const, null)
const disabled = atom({ plugin: 'model-advisor', key: 'disabled' } as const, false)
const decided = atom({ plugin: 'model-advisor', key: 'decided' } as const, false)
const openers = atom({ plugin: 'model-advisor', key: 'openers' } as const, 0)
const lastLevel = atom({ plugin: 'model-advisor', key: 'lastLevel' } as const, null)
const seenEffort = atom({ plugin: 'model-advisor', key: 'seenEffort' } as const, null)

const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Below this size switching models is cheap: there is little to re-read.
const SMALL_CONTEXT = 40_000

// Above this level a subagent does not go without a person deciding it.
const MAX_SUBAGENT_LEVEL = 6

type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
type Level = { model: string; effort: Effort; name: string }

// Eight model·effort profiles, from cheapest to most capable, set against Anthropic's
// documentation for the 5.5 models and checked by the author on 30 real requests:
// 24 exact, 28 within one profile. Effort max is left out: it costs a lot and adds little.
const LEVELS: Record<number, Level> = {
  1: { model: 'claude-haiku-5-5', effort: 'low', name: 'Haiku 5.5 · low' },
  2: { model: 'claude-haiku-5-5', effort: 'medium', name: 'Haiku 5.5 · medium' },
  3: { model: 'claude-sonnet-5-5', effort: 'medium', name: 'Sonnet 5.5 · medium' },
  4: { model: 'claude-sonnet-5-5', effort: 'high', name: 'Sonnet 5.5 · high' },
  5: { model: 'claude-opus-5-5', effort: 'medium', name: 'Opus 5.5 · medium' },
  6: { model: 'claude-opus-5-5', effort: 'high', name: 'Opus 5.5 · high' },
  7: { model: 'claude-opus-5-5', effort: 'xhigh', name: 'Opus 5.5 · xhigh' },
  8: { model: 'claude-fable-5-1', effort: 'high', name: 'Fable 5.1 · high' },
}

const STRENGTH: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

// Mid-session the model in use stays and only the effort moves: switching models makes
// Claude re-read the conversation without the cache. A stronger model covers the lighter
// profiles at low effort (Anthropic reports Opus 5.5 at low close to its default on several
// coding evaluations, at much lower cost); a profile the model in use does not cover makes
// the mod propose a stronger model.
const EFFORT_ON_MODEL: Record<Family, Partial<Record<number, Effort>>> = {
  haiku: { 1: 'low', 2: 'medium' },
  sonnet: { 1: 'low', 2: 'low', 3: 'medium', 4: 'high' },
  opus: { 1: 'low', 2: 'low', 3: 'low', 4: 'low', 5: 'medium', 6: 'high', 7: 'xhigh' },
  fable: { 1: 'low', 2: 'low', 3: 'low', 4: 'low', 5: 'medium', 6: 'high', 7: 'high', 8: 'high' },
}

// The most each model gives when the profile is above it: the "stay on this model"
// alternative, and a subagent's effort when its model was already chosen.
const TOP_EFFORT: Record<Family, Effort> = { haiku: 'high', sonnet: 'high', opus: 'xhigh', fable: 'high' }

// Subagents start without the conversation, so there the model is chosen at no cost.
// Only these types inherit the session's model: the others have a model chosen by
// whoever wrote them.
const GENERIC_SUBAGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude'])

// Prices and guidance from platform.claude.com/docs (pricing and effort pages),
// checked on 26 October 2026. Update them here when Anthropic changes them.
const FACTS = `Facts from Anthropic's documentation (October 2026), prices per million input/output tokens:
- Haiku 5.5: $0.10/$0.50 (prompts over 100K tokens: $0.50/$2.50). Default effort medium; low suits chat, short tool tasks and simple requests.
- Sonnet 5.5: $2/$10. Default effort high. For agentic work, medium for well-specified tasks and high for harder or longer ones. For the hardest long-horizon work Anthropic points to Opus.
- Opus 5.5: $4/$20, strongest at multistep agentic work in a real repository. Default effort medium; on several coding evaluations low comes close to it at much lower cost. xhigh is for long-running work (over 30 minutes).
- Fable 5.1: $10/$50, the most capable model. Default effort high.
- xhigh and max only where they have been shown to help: thinking and replies get much longer.`

const SCALE = `1 = Haiku 5.5 · low: greetings, small talk, thanks, questions about the conversation itself.
2 = Haiku 5.5 · medium: reading one fact or running one command and reporting it (disk space, a version, a service's status), summarising what was already said.
3 = Sonnet 5.5 · medium: mechanical steps with a known, already-decided procedure: commit and push files that are ready, add a line, rename, run an existing script.
4 = Sonnet 5.5 · high: everyday work with a clear scope that needs some writing or reasoning: update a note or document with content to synthesise, a small local configuration change, reorganise files with checks, answer a technical question by searching the project.
5 = Opus 5.5 · medium: work that needs judgment or touches things that are costly to get wrong: implementing a feature, writing new scripts, strategic advice, weighing options, operations on production projects (final audio or video, publishing, deploys, client accounts and data), configuration across several machines.
6 = Opus 5.5 · high: diagnosing something that does not work, destructive or irreversible operations in production (deleting services, data, volumes), long creative or technical work to do well unattended, checks where a mistake is expensive.
7 = Opus 5.5 · xhigh: very long autonomous work (over half an hour), several intermittent defects to understand together, ambiguous causes, architecture decisions, auditing a system.
8 = Fable 5.1 · high: only when Opus xhigh has already failed or the reasoning is exceptionally hard (deep research, open problems). Never for ordinary work.`

const FORMAT = `Answer ONLY with JSON, no other text: {"profile": <1-8>, "reason": "<at most 12 words>", "ultracode": <true|false>}`

const INSTRUCTIONS = `You advise Claude Code on model and effort. Claude Code is the assistant that works on the user's machines with a shell, files, git, the web and connected tools. You receive the request the user is about to send, with an excerpt of what was happening before. Pick the CHEAPEST profile that does the job right the first time: redoing botched work costs more than the right model.

${FACTS}

The profiles:
${SCALE}

Rules:
- Judge the work the request sets in motion, not the length of the text: "ok go ahead" weighs as much as the work proposed just before it in the excerpt.
- Requests can be in any language, often typed in a hurry and with typos.
- "ultracode": true only if the request asks for an audit or a broad review of a whole system or repository, where several agents in parallel are needed; otherwise false.

${FORMAT}`

const SUBAGENT_INSTRUCTIONS = `You advise Claude Code on model and effort. You receive the brief a Claude Code session wrote for a subagent: a self-contained assignment the subagent carries out without seeing the conversation it comes from. Estimate only the work the brief describes and pick the CHEAPEST profile that does it right the first time. Searching, reading and listing files is cheap even when the brief is long; what counts is the judgment required and how much a mistake costs.

${FACTS}

The profiles:
${SCALE}

"ultracode" is always false for a subagent.
${FORMAT}`

// At the top of the main session's prompt: whoever orchestrates knows the work it
// delegates better than any classifier, so it picks the model itself.
const ORCHESTRATOR_GUIDE = `# Model for subagents and sessions
When you launch a generic subagent (Agent tool) or start a session (start_session), choose the model yourself with the \`model\` parameter, based on the work you hand over: Haiku to search, read, list and summarise; Sonnet for work with a clear scope; Opus for judgment, implementation, diagnosis and production operations. Take the cheapest one that does the job right the first time. The subagent's effort is set by the model-advisor mod.`

// A short confirmation continues the work already under way: it keeps the level in use.
const CONFIRMATION_WORDS = new Set([
  'ok', 'okay', 'k', 'yes', 'yep', 'yeah', 'sure', 'right', 'exactly', 'confirmed', 'agreed',
  'go', 'ahead', 'on', 'proceed', 'continue', 'carry', 'do', 'it', 'please', 'fine', 'good',
  'great', 'perfect', 'thanks', 'thank', 'you', 'done', 'all', 'and', 'then', 'that', 'sounds',
  // Italian, Spanish, French, German
  'si', 'sì', 'sí', 'procedi', 'vai', 'perfetto', 'grazie', 'oui', 'merci', 'vas-y', 'ja', 'danke',
])

type Advice = { level: number; reason: string; ultracode?: boolean }

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
    const level = Number(j.profile ?? j.level)
    if (!Number.isInteger(level) || !LEVELS[level]) {
      return null
    }

    return { level, reason: typeof j.reason === 'string' ? j.reason.trim() : '', ultracode: j.ultracode === true }
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
  previous: number | null = null,
  instructions = INSTRUCTIONS,
  before = '',
): Promise<Advice | null> {
  const context =
    (before ? `Excerpt of what was happening before (end of the assistant's last reply):\n«${before}»\n\n` : '') +
    (previous === null ? '' : `The previous request was profile ${previous}: take it into account only if this one continues it.\n\n`)
  try {
    const r = await $.model.complete({
      model: 'sonnet',
      system: instructions,
      prompt: `${context}${instructions === INSTRUCTIONS ? "The user's request" : "The subagent's brief"}:\n"""\n${text.slice(0, 1500)}\n"""`,
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
  $.ui.status(next ? `Level: ${next.name}` : undefined)
  if ((before?.model ?? sessionModel) !== (next?.model ?? sessionModel)) {
    // The model's name sits in a system prompt section: from the next turn prompt.section rewrites it.
    $.ui.invalidate('prompt.section')
  }
}

function sameModel(a: string, b: string): boolean {
  return modelName(a) === modelName(b)
}

function modelChanged(c: Choice | null): c is Choice {
  return c !== null && !sameModel(c.model, c.sessionModel)
}

// This turn's system prompt is already composed and names the session's model:
// without an explanation the model trusts the prompt.
function modelNote(c: Choice): string {
  return (
    `The model-advisor mod, installed by the user, picked the model for this request: ` +
    `it runs on ${modelName(c.model)} (ID ${c.model}), effort ${c.effort}. The system prompt still names ` +
    `the session's model because it was composed before the choice; it updates from the next turn. ` +
    `For the model's name and for Co-Authored-By lines, this note applies.`
  )
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
  if (firstRequest) {
    await update($, decided, () => true)
  }

  const p = propose(advice.level, inUse.model, firstRequest)
  if (!p || (sameModel(p.recommended.model, inUse.model) && p.recommended.effort === inUse.effort)) {
    return `stays on ${levelName(inUse.model, inUse.effort)}`
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

  const reason = inParens(advice.reason)
  let question = `For this request I recommend ${p.recommended.name}${reason}.`
  if (p.switchesModel) {
    const context = (await $.session.usage()).context.tokens ?? 0
    const cost =
      context < SMALL_CONTEXT
        ? 'The conversation is still short: switching now is cheap.'
        : `Switching models now makes Claude re-read the whole conversation (about ${Math.round(context / 1000)}k tokens) without the cache.`
    question = `This request needs a stronger model: I recommend ${p.recommended.name}${reason}. ${cost}`
  }

  const take = `${p.recommended.name} (recommended)`
  const alternative = p.alternative ? `${p.alternative.name} (same model)` : null
  const keep = `Keep ${levelName(inUse.model, inUse.effort)}`
  const stop = 'Stop asking in this session'
  const options = [take, ...(alternative ? [alternative] : []), keep, stop]

  let answer: string
  try {
    answer = await $.ui.ask(`${question} Which one?`, { options, header: 'Level' })
  } catch {
    return `question for ${p.recommended.name} closed unanswered: stays on ${levelName(inUse.model, inUse.effort)}`
  }

  const chosen = answer === take ? p.recommended : answer === alternative ? p.alternative : null
  if (chosen) {
    await apply($, advice.level, chosen, sessionModel, sessionEffort)

    return `question for ${p.recommended.name}: chose ${chosen.name}`
  }
  if (answer === stop) {
    await update($, disabled, () => true)
    $.ui.toast('Advice off for this session: /model-advisor on turns it back on')

    return `question for ${p.recommended.name}: advice turned off`
  }

  return `question for ${p.recommended.name}: kept ${levelName(inUse.model, inUse.effort)}`
}

// One line per decision in <config dir>/mods/model-advisor/<session>.jsonl, to read back
// what the mod estimated and why. One file per session: $.fs cannot append, and this way
// two chats do not overwrite each other.
let folderReady = false

async function record(
  $: EngineInterface,
  entry: { kind: 'request' | 'subagent'; text: string; level?: number; reason?: string; outcome: string },
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

export const register: Register = on => {
  // The effort chosen for each subagent, applied to each of its steps.
  const subagentEffort = new Map<string, Effort>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-advisor',
      description: 'Model and effort advice: on, off, reset (back to the session level)',
    })

    return next(e)
  })

  on('command.run', { command: 'model-advisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await update($, disabled, () => true)

      return { text: 'Advice off for this session.' }
    }
    if (arg === 'on') {
      await update($, disabled, () => false)

      return { text: 'Advice on: I set the effort myself and ask only to switch models.' }
    }
    if (arg === 'reset') {
      const c = await read($, choice)
      await update($, choice, () => null)
      $.ui.status(undefined)
      if (modelChanged(c)) {
        $.ui.invalidate('prompt.section')
      }

      return { text: "Back to the session's model and effort." }
    }
    const c = await read($, choice)
    const state = (await offInMods($)) ? 'off from /mods' : (await read($, disabled)) ? 'off' : 'on'

    return {
      text: `Advice ${state}. Level in use: ${c ? c.name : "the session's"}. Commands: /model-advisor on | off | reset. To skip one request, start it with ~. Decision log: ${await claudeDir($)}/mods/model-advisor/${await $.session.id()}.jsonl`,
    }
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
    if (isConfirmation(text)) {
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
    const advice = await assess($, text, await read($, lastLevel), INSTRUCTIONS, await lastReply($))
    if (advice?.ultracode && !/ultracode/i.test(text)) {
      $.ui.toast('For an audit this broad, ultracode helps: add it to the request to work with several agents.')
    }
    const outcome = advice
      ? await decide($, advice, firstRequest, await $.session.model(), await read($, seenEffort))
      : 'no estimate: level in use kept'
    await record($, {
      kind: 'request',
      text,
      level: advice?.level,
      reason: advice?.reason,
      outcome: advice?.ultracode ? `${outcome}; ultracode suggested` : outcome,
    })
    const after = await read($, choice)
    if (modelChanged(after) && after.model !== before?.model) {
      return next({ ...e, context: [...(e.context ?? []), modelNote(after)] })
    }

    return next(e)
  }).catch((_, e, next) => next(e)) // if the mod fails, the request goes through anyway

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.surfaces.length === 0 || !(await enabled($))) {
      return r
    }

    return { sections: [...r.sections, { id: 'model-advisor:orchestrate', text: ORCHESTRATOR_GUIDE, scope: 'session' }] }
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
    const advice = await assess($, e.prompt, null, SUBAGENT_INSTRUCTIONS)
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
      const who = e.model ? 'model chosen by the session' : 'chosen by the mod'
      $.ui.log(`subagent «${e.description}» on ${levelName(model, effort)}, ${who}${inParens(advice.reason)}`)
      await record($, {
        kind: 'subagent',
        text: `${e.description}: ${e.prompt}`,
        level: advice.level,
        reason: advice.reason,
        outcome: `${levelName(model, effort)}, ${who}`,
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
    if ((await read($, seenEffort)) !== sessionEffort) {
      await update($, seenEffort, () => sessionEffort)
    }

    const c = await read($, choice)
    if (!c) {
      return yield* next(e)
    }
    if (await offInMods($)) {
      // Off from /mods: back to the session's level until it is turned on again.
      $.ui.status(undefined)

      return yield* next(e)
    }
    if (!sameModel(c.sessionModel, e.model) || (c.sessionEffort !== null && c.sessionEffort !== sessionEffort)) {
      // The session's model or effort changed with /model or /effort: that choice wins.
      await update($, choice, () => null)
      $.ui.status(undefined)
      $.ui.invalidate('prompt.section')

      return yield* next(e)
    }
    if (c.sessionEffort === null) {
      // On the first request the session's effort was not known yet.
      await update($, choice, v => (v ? { ...v, sessionEffort } : v))
    }

    return yield* next({ ...e, model: c.model, effort: c.effort })
  }).catch(async function* (_, e, next) {
    return yield* next(e)
  })
}
