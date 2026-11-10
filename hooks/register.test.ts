import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LEVELS, SCALE, isConfirmation, isItalian, parseAdvice, propose } from './register'

const OPUS_XHIGH = { model: 'claude-opus-5-5', effort: 'xhigh' } as const

type Options = {
  level?: number
  answer?: 'take' | 'alternative' | 'keep'
  surfaces?: string[]
  turns?: number
  context?: number
  model?: string
  switches?: Record<string, unknown>
  // The language Claude Code is set to, as its /config row holds it.
  language?: string
}

// Nothing sits below the mod: these hooks play the engine.
function engine(on: On, options: Options) {
  const seen = {
    assessments: 0,
    text: '',
    context: [] as string[],
    log: '',
    prompt: '',
    system: '',
    questions: [] as string[],
    steps: [] as { model: string; effort?: unknown; agentId?: string }[],
    subagentModel: undefined as string | undefined,
    lines: [] as string[],
    written: [] as string[],
  }
  on('session.surfaces', () => ({ value: (options.surfaces ?? ['desktop']) as never }))
  on('session.turns', () => ({ value: options.turns ?? 0 }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.exists', (_, e: any) => {
    const path = String(e.path ?? e)
    return { value: path.endsWith('.jsonl') ? seen.log !== '' : path.endsWith('switches.json') && !!options.switches }
  })
  on('fs.read', (_, e: any) => ({
    value: (String(e.path ?? e).endsWith('.jsonl') ? seen.log : JSON.stringify(options.switches ?? {})) as never,
  }))
  on('fs.write', (_, e: any) => {
    seen.written.push(String(e.path))
    if (String(e.path).endsWith('.jsonl')) seen.log = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { code: 0, stdout: '/home/test/.claude', stderr: '' } as never }))
  on('config.list', () => ({
    value: (options.language ? [{ key: 'language', label: 'Language', kind: 'text', value: options.language }] : []) as never,
  }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/project' }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'I propose to implement phase 3: API and package.', toolUses: [] }] as never }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: options.context ?? 120_000, window: 1_000_000 }, rateLimits: [] } }))
  on('model.complete', (_, e: any) => {
    seen.assessments += 1
    seen.prompt = String(e.prompt)
    seen.system = String(e.system)
    return {
      value: {
        isAnswered: true,
        text: `{"profile": ${options.level ?? 3}, "reason": "routine with a clear scope", "ultracode": false}`,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never,
    }
  })
  // $.ui.ask goes through the AskUserQuestion dialog: here the fake user answers.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e: any) => {
    const q = e.questions[0]
    seen.questions.push(q.question)
    const labels: string[] = q.options.map((o: { label: string }) => o.label)
    const look = {
      take: ['(recommended)', '(consigliato)'],
      alternative: ['(same model)', '(stesso modello)'],
      keep: ['Keep ', 'Tieni '],
    }[options.answer ?? 'take']
    const picked = labels.find(l => look.some(x => l.includes(x))) ?? ''
    return { result: { questions: e.questions, answers: { [q.question]: picked } } as never }
  })
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are powered by Opus 5.5.', scope: 'shared' as const }],
  }))
  on('attribution.text', (_, e) => ({ text: e.text }))
  on('prompt.section', (_, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e: any) => {
    seen.lines.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    seen.text = e.text
    seen.context = [...(e.context ?? [])]
    return { text: e.text }
  })
  on('agent.spawn', (_, e) => {
    seen.subagentModel = e.model
    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })
  on('turn.step', async function* (_, e) {
    seen.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  return seen
}

async function request($: any, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: any, turnId: string, session: object = OPUS_XHIGH, agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, messageCount: 1, ...session, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // no chunks: the fake engine's answer is empty
  }
}

async function subagent($: any, fields: object = {}) {
  await $.agent.spawn({
    tool_use_id: 'tu-1',
    prompt: 'search the project files for where the logger is configured',
    description: 'Find the logger',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...fields,
  })
}

test('recognises short confirmations and lets real requests through', () => {
  expect(isConfirmation('ok go ahead')).toBe(true)
  expect(isConfirmation('yes, do it all')).toBe(true)
  expect(isConfirmation('Ok, perfect, proceed!')).toBe(true)
  expect(isConfirmation('ok procedi')).toBe(true)
  expect(isConfirmation('Va bene, continua pure')).toBe(true)
  expect(isConfirmation("d'accordo, avanti")).toBe(true)
  expect(isConfirmation('va bene ma prima controlla i test')).toBe(false)
  expect(isConfirmation('where did we leave off?')).toBe(false)
  expect(isConfirmation('update and push the vualt')).toBe(false)
  expect(isConfirmation('ok close it all then update the notes with commit and push')).toBe(false)
})

test('reads the advice JSON even with text around it', () => {
  expect(parseAdvice('{"profile": 4, "reason": "needs judgment", "ultracode": true}')).toEqual({ level: 4, reason: 'needs judgment', ultracode: true })
  expect(parseAdvice('Here: {"level": 2, "reason": "x"} end')?.level).toBe(2)
  expect(parseAdvice('{"profilo": 5, "motivo": "serve giudizio", "ultracode": false}')).toEqual({ level: 5, reason: 'serve giudizio', ultracode: false })
  expect(parseAdvice('{"level": 9}')).toBe(null)
  expect(parseAdvice('nothing')).toBe(null)
})

test('mid-session it proposes only the effort, a different model only if stronger', () => {
  expect(propose(2, 'claude-opus-5-5', false)?.recommended).toEqual({
    model: 'claude-opus-5-5', effort: 'low', name: 'Opus 5.5 · low',
  })
  expect(propose(3, 'claude-sonnet-5-5', false)?.switchesModel).toBe(false)
  expect(propose(5, 'claude-sonnet-5-5', false)?.recommended.model).toBe('claude-opus-5-5')
  expect(propose(5, 'claude-sonnet-5-5', false)?.alternative?.name).toBe('Sonnet 5.5 · high')
  expect(propose(2, 'claude-opus-5-5', true)?.recommended.model).toBe('claude-haiku-5-5')
})

test('on the first request it applies model and effort and keeps them on confirmations', async ($, on) => {
  const seen = engine(on, { level: 3, turns: 0 })

  await request($, "update the notes with today's changes and push")
  await step($, 't1')
  expect(seen.questions.length).toBe(1)
  expect(seen.steps[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium', agentId: undefined })

  await request($, 'ok go ahead')
  await step($, 't2')
  expect(seen.assessments).toBe(1)
  expect(seen.questions.length).toBe(1)
  expect(seen.steps[1]?.model).toBe('claude-sonnet-5-5')
})

test('mid-session it changes only the effort on the model in use, without asking', async ($, on) => {
  const seen = engine(on, { level: 2, turns: 5 })

  await request($, 'commit and push')
  await step($, 't1')
  expect(seen.questions.length).toBe(0)
  expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'low', agentId: undefined })
})

test('effort goes up at once and comes down only after two light requests', async ($, on) => {
  const options: Options = { level: 6, turns: 5 }
  const seen = engine(on, options)
  const OPUS_MEDIUM = { model: 'claude-opus-5-5', effort: 'medium' }

  await request($, 'why does the deploy fail at random?')
  await step($, 't1', OPUS_MEDIUM)
  expect(seen.steps[0]?.effort).toBe('high')

  options.level = 2
  await request($, 'and where is the log?')
  await step($, 't2', OPUS_MEDIUM)
  expect(seen.steps[1]?.effort).toBe('high')

  await request($, 'rename the log file')
  await step($, 't3', OPUS_MEDIUM)
  expect(seen.steps[2]?.effort).toBe('low')
  expect(seen.questions.length).toBe(0)
})

test('an opening greeting does not decide the model: the first real request does', async ($, on) => {
  const HAIKU_LOW = { model: 'claude-haiku-5-5', effort: 'low' }
  const options: Options = { level: 1, turns: 0, model: HAIKU_LOW.model }
  const seen = engine(on, options)

  await request($, 'hi')
  await step($, 't1', HAIKU_LOW)
  expect(seen.questions.length).toBe(0)
  expect(seen.steps[0]).toEqual({ ...HAIKU_LOW, agentId: undefined })

  options.turns = 1
  options.level = 6
  await request($, 'write the closed form of this recurrence and prove it')
  await step($, 't2', HAIKU_LOW)
  expect(seen.questions.length).toBe(1)
  expect(seen.questions[0]).toContain('I recommend Opus 5.5 · high')
  expect(seen.questions[0]).not.toContain('without the cache')
  expect(seen.steps[1]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
})

test('with a short conversation, switching models is presented as cheap', async ($, on) => {
  const seen = engine(on, { level: 5, turns: 5, context: 10_000, model: 'claude-sonnet-5-5' })

  await request($, 'why does the live server keep going down?')
  await step($, 't1', { model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(seen.questions[0]).toContain('switching now is cheap')
})

test('mid-session it proposes a stronger model, with the cost of the re-read', async ($, on) => {
  const seen = engine(on, { level: 6, turns: 5, model: 'claude-sonnet-5-5' })

  await request($, 'why does the live server keep going down?')
  await step($, 't1', { model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(seen.questions[0]).toContain('needs a stronger model')
  expect(seen.questions[0]).toContain('120k tokens')
  expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
})

test('the same proposal can stay on the model in use, with more effort', async ($, on) => {
  const seen = engine(on, { level: 6, turns: 5, answer: 'alternative', model: 'claude-sonnet-5-5' })

  await request($, 'why does the live server keep going down?')
  await step($, 't1', { model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(seen.steps[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'high', agentId: undefined })
})

test('keeping the current level changes nothing', async ($, on) => {
  const seen = engine(on, { level: 2, answer: 'keep' })

  await request($, 'commit and push')
  await step($, 't1')
  expect(seen.questions.length).toBe(1)
  expect(seen.steps[0]).toEqual({ ...OPUS_XHIGH, agentId: undefined })
})

test('it asks nothing if the advice matches the level in use', async ($, on) => {
  const seen = engine(on, { level: 7 })

  await request($, 'redesign the architecture of the deployment pipeline')
  await step($, 't1')
  expect(seen.questions.length).toBe(0)
  expect(seen.steps[0]).toEqual({ ...OPUS_XHIGH, agentId: undefined })
})

test('if the session changes model with /model, that choice wins', async ($, on) => {
  const seen = engine(on, { level: 2 })

  await request($, 'commit and push')
  await step($, 't1')
  expect(seen.steps[0]?.model).toBe('claude-haiku-5-5')

  await request($, 'ok')
  await step($, 't2', { model: 'claude-fable-5-2', effort: 'high' })
  expect(seen.steps[1]).toEqual({ model: 'claude-fable-5-2', effort: 'high', agentId: undefined })
})

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['desktop'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

test('with a model chosen by the mod, the model knows which model it is and signs with it', async ($, on) => {
  const seen = engine(on, { level: 3, turns: 0 })

  await request($, "update the notes with today's changes and push")
  expect(seen.context.at(-1)).toContain('runs on Sonnet 5.5 (ID claude-sonnet-5-5)')
  await step($, 't1')

  const section = await $.prompt.section({
    name: 'env_info_model',
    text: 'You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.',
  })
  expect(section.text).toBe('You are powered by the model named Sonnet 5.5. The exact model ID is claude-sonnet-5-5.')

  const signature = await $.attribution.text({
    kind: 'commit',
    text: 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  })
  expect(signature.text).toBe('Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>')

  await request($, 'ok go ahead')
  expect(seen.context.length).toBe(0)
})

test("the main session's prompt teaches it to pick the subagents' model", async ($, on) => {
  engine(on, {})

  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.at(-1)?.id).toBe('model-advisor:orchestrate')
  const nobody = await $.prompt.compose({ ...COMPOSE, surfaces: [] })
  expect(nobody.sections.length).toBe(1)
})

test('generic subagents get model and effort without questions', async ($, on) => {
  const seen = engine(on, { level: 2 })

  await subagent($)
  expect(seen.subagentModel).toBe('claude-haiku-5-5')
  expect(seen.questions.length).toBe(0)
  expect(seen.lines.some(l => l.includes('«Find the logger» on Haiku 5.5 · medium, chosen by the mod'))).toBe(true)

  await step($, 't9', OPUS_XHIGH, 'agent-1')
  expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'medium', agentId: 'agent-1' })
})

test("if the session picks the subagent's model, the mod keeps it and adds the effort", async ($, on) => {
  const seen = engine(on, { level: 5 })

  await subagent($, { model: 'sonnet' })
  expect(seen.subagentModel).toBe('sonnet')
  expect(seen.lines.some(l => l.includes('Sonnet · high, model chosen by the session'))).toBe(true)
  await step($, 't9', OPUS_XHIGH, 'agent-1')
  expect(seen.steps[0]?.effort).toBe('high')
})

test('a subagent does not go above Opus high on its own, and types with their own model stay as they were', async ($, on) => {
  const seen = engine(on, { level: 7 })

  await subagent($)
  expect(seen.subagentModel).toBe('claude-opus-5-5')
  await step($, 't9', OPUS_XHIGH, 'agent-1')
  expect(seen.steps[0]?.effort).toBe('high')

  await subagent($, { subagentType: 'claude-code-guide' })
  expect(seen.assessments).toBe(1)
})

test('with nobody watching (claude -p) it neither assesses nor asks', async ($, on) => {
  const seen = engine(on, { surfaces: [] })

  await request($, 'update the notes and push')
  await step($, 't1')
  await subagent($)
  expect(seen.assessments).toBe(0)
  expect(seen.steps[0]).toEqual({ ...OPUS_XHIGH, agentId: undefined })
})

test('a request starting with ~ skips the advice', async ($, on) => {
  const seen = engine(on, {})

  await request($, '~ update the notes and push')
  await step($, 't1')
  expect(seen.assessments).toBe(0)
  expect(seen.text).toBe('update the notes and push')
})

test('turned off from the /mods panel it neither assesses, asks nor touches the steps', async ($, on) => {
  const seen = engine(on, { level: 2, switches: { 'model-advisor': false } })

  await request($, 'commit and push')
  await step($, 't1')
  await subagent($)
  expect(seen.assessments).toBe(0)
  expect(seen.questions.length).toBe(0)
  expect(seen.steps[0]).toEqual({ ...OPUS_XHIGH, agentId: undefined })
})

test('every decision ends up in the log, with level, reason and outcome', async ($, on) => {
  const options: Options = { level: 3, turns: 0 }
  const seen = engine(on, options)

  await request($, "update the notes with today's changes and push")
  await step($, 't1')
  await request($, 'ok go ahead')
  options.turns = 2
  options.level = 2
  await subagent($)

  const lines = seen.log.trim().split('\n').map(l => JSON.parse(l))
  expect(lines.length).toBe(3)
  expect(lines[0]).toMatchObject({
    kind: 'request',
    cwd: '/project',
    level: 3,
    reason: 'routine with a clear scope',
    outcome: 'question for Sonnet 5.5 · medium: chose Sonnet 5.5 · medium',
  })
  expect(lines[1]?.outcome).toBe('confirmation: level in use kept')
  expect(lines[2]).toMatchObject({ kind: 'subagent', level: 2, outcome: 'Haiku 5.5 · medium, chosen by the mod' })
})

test('the log lives in the Claude Code config folder', async ($, on) => {
  const seen = engine(on, { level: 3, turns: 0 })

  await request($, "update the notes with today's changes and push")
  expect(seen.written).toContain('/home/test/.claude/mods/model-advisor/test-session.jsonl')
})

test('the classifier sees the end of the previous reply', async ($, on) => {
  const seen = engine(on, { level: 5, turns: 3 })

  await request($, 'go ahead with that part please')
  expect(seen.prompt).toContain('I propose to implement phase 3')
})

test('the two languages describe the same eight profiles', () => {
  for (const scale of [SCALE.en, SCALE.it]) {
    const lines = scale.split('\n')
    expect(lines.length).toBe(Object.keys(LEVELS).length)
    lines.forEach((line, i) => expect(line.startsWith(`${i + 1} = ${LEVELS[i + 1]?.name}: `)).toBe(true))
  }
})

test('recognises Italian among the ways Claude Code names a language', () => {
  expect(isItalian('Italian')).toBe(true)
  expect(isItalian(' italiano ')).toBe(true)
  expect(isItalian('it-IT')).toBe(true)
  expect(isItalian('English')).toBe(false)
  expect(isItalian(undefined)).toBe(false)
})

test('with Claude Code set to Italian, the classifier and the question are in Italian', async ($, on) => {
  const seen = engine(on, { level: 6, turns: 5, model: 'claude-sonnet-5-5', language: 'Italian' })

  await request($, 'perché il server live continua a cadere?')
  await step($, 't1', { model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(seen.system).toContain('Sei il consigliere di modello ed effort')
  expect(seen.prompt).toContain("Richiesta dell'utente")
  expect(seen.questions[0]).toContain('serve un modello più forte: consiglio Opus 5.5 · high')
  expect(seen.questions[0]).toContain('circa 120k token')
  expect(seen.steps[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })

  const lines = seen.log.trim().split('\n').map(l => JSON.parse(l))
  expect(lines[0]?.outcome).toBe('question for Opus 5.5 · high: chose Opus 5.5 · high')
})

test('the language option wins over the language Claude Code is set to', { options: { language: 'en' } }, async ($, on) => {
  const seen = engine(on, { level: 6, turns: 5, model: 'claude-sonnet-5-5', language: 'Italian' })

  await request($, 'perché il server live continua a cadere?')
  expect(seen.system).toContain('You advise Claude Code on model and effort')
  expect(seen.questions[0]).toContain('needs a stronger model')
})

test('set to Italian by option, it speaks Italian whatever Claude Code is set to', { options: { language: 'it' } }, async ($, on) => {
  const seen = engine(on, { level: 2 })

  await subagent($)
  expect(seen.system).toContain('Ricevi il brief')
  expect(seen.lines.some(l => l.includes('sotto-agente «Find the logger» su Haiku 5.5 · medium, scelto dal mod'))).toBe(true)

  const r = await $.prompt.compose(COMPOSE)
  expect(r.sections.at(-1)?.text).toContain('# Modello per sotto-agenti e sessioni')
})

test("the person's note about their work reaches the classifier, before the rules", { options: { context: 'I edit video in Resolve; a final render is production work.' } }, async ($, on) => {
  const seen = engine(on, { level: 5, turns: 3 })

  await request($, 'render the final cut')
  const note = seen.system.indexOf('I edit video in Resolve')
  expect(note).toBeGreaterThan(seen.system.indexOf('8 = Fable 5.2'))
  expect(note).toBeLessThan(seen.system.indexOf('Rules:'))
})

test('with no note, the classifier gets the instructions alone', async ($, on) => {
  const seen = engine(on, { level: 5, turns: 3 })

  await request($, 'render the final cut')
  expect(seen.system).not.toContain('A note from the person')
  expect(seen.system).toContain('Never for ordinary work.\n\nRules:')
})
