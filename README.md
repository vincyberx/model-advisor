# model-advisor

A Claude Code mod that picks the model and effort for each request you type.

Before a request starts, the mod asks Sonnet 5.5 (at low effort) how much work the request sets in motion, on a scale of eight model·effort profiles. Then:

- **Effort on the model you're using is adjusted on its own, with no question.** It goes up at once and comes down only after two light requests in a row, so a quick question in the middle of heavy work doesn't deflate it.
- **A different model is proposed, never imposed.** On the first request of a session the mod proposes the profile's model and effort. Later in the session it asks only when the work needs a *stronger* model than the one in use, and it tells you what switching costs: changing model mid-conversation makes Claude re-read the whole conversation without the prompt cache.
- **Confirmations keep the level.** "ok go ahead" weighs as much as the work it approves, so a short confirmation is not assessed again.
- **Subagents get a model and effort too.** Generic subagents (`general-purpose`, `Explore`, `Plan`, `claude`) start without the conversation, so the mod sets their model and effort without asking, up to Opus 5.5 · high. If the main session already chose a subagent's model, the mod keeps it and only adds the effort. Subagent types that come with their own model are left alone.
- **Claude knows which model it is.** When the mod switches model, it rewrites the model's name in the system prompt and in `Co-Authored-By` lines.
- **Every decision is logged**, so you can check afterwards what it estimated and why.

## The profiles

| # | Profile | For |
| - | ------- | --- |
| 1 | Haiku 5.5 · low | greetings, small talk, questions about the conversation |
| 2 | Haiku 5.5 · medium | reading one fact or running one command and reporting it |
| 3 | Sonnet 5.5 · medium | mechanical steps with a known procedure: commit and push, rename, run an existing script |
| 4 | Sonnet 5.5 · high | everyday work with a clear scope: update a document, a small config change, answer a question by searching the project |
| 5 | Opus 5.5 · medium | work that needs judgment or is costly to get wrong: a new feature, new scripts, deploys, client data |
| 6 | Opus 5.5 · high | diagnosing what's broken, irreversible operations in production, long work done unattended |
| 7 | Opus 5.5 · xhigh | very long autonomous work, several intermittent defects, architecture decisions, audits |
| 8 | Fable 5.1 · high | only when Opus xhigh has failed or the reasoning is exceptionally hard |

Effort `max` is left out on purpose: Anthropic's guidance is to use it only where it has been shown to help.

## Install

At the prompt of a terminal session:

```
/plugin install model-advisor --marketplace vincyberx/model-advisor
```

Answer `y` to add the marketplace, then pick a scope (user scope is the first one).

From a shell:

```bash
claude plugin install model-advisor --marketplace vincyberx/model-advisor
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `vincyberx/model-advisor`, then **Add plugin**.

## Use

| | |
| --- | --- |
| `/model-advisor` | shows whether advice is on, the level in use, and where this session's log is |
| `/model-advisor off` / `on` | turns advice off or on for this session |
| `/model-advisor reset` | goes back to the session's own model and effort |
| `~ your request` | skips the advice for one request |
| `/mods` panel | turns the mod off in every chat |

Choosing a model with `/model` or an effort with `/effort` always wins: the mod drops its own choice when it sees the session's change.

Each decision is a line in `~/.claude/mods/model-advisor/<session id>.jsonl` (or under `$CLAUDE_CONFIG_DIR` if you set it), with the time, the folder, the first 160 characters of the request, the profile, the reason and what happened.

## What it costs

- **One extra model call per request you type, and one per generic subagent.** The call goes to Sonnet 5.5 at low effort with about 1,000 tokens of instructions, plus up to 1,500 characters of your request and 800 characters of the previous reply, and at most 300 output tokens. At API prices ($2 / $10 per million input/output tokens) that is roughly $0.003–0.006 per request. That figure is an estimate from the prompt's length, not a measurement. On a Claude subscription it counts toward your usage limits instead.
- **A short wait before each request starts**, while the classifier answers: usually a few seconds, never more than 20. If it times out or fails, the request goes through unchanged.
- **Switching models mid-session re-reads the conversation without the cache.** That's why the mod asks first and shows the size of the conversation. Changing effort on the same model doesn't do this, so the mod does it without asking.

## Limits

- **The mod API is early access.** Claude Code's function hooks may change between releases without notice, and the mod may stop working until it's updated.
- **Managed organizations.** Where an organization manages Claude Code, the `prompt.compose`, `prompt.section` and `attribution.text` hooks don't run for plugins a person installs. Model and effort switching still work, but the model's name in the system prompt and in `Co-Authored-By` lines isn't corrected, and the main session gets no guidance on choosing subagent models.
- **Model names, prices and the scale are written for the 5.5 models** (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1), as documented by Anthropic in October 2026. When Anthropic releases new models or changes prices, `LEVELS` and `FACTS` in `hooks/register.ts` need updating. Profiles that use a model your plan doesn't include won't work.
- **The calibration is small.** The scale was checked by the author on 30 real requests (24 exact, 28 within one profile) and in a few days of everyday use. That's evidence it works for one person's work, not a benchmark. The classifier is itself a language model and can misjudge a request. How profiles map onto a stronger model's effort (for example, Opus at low effort covering the Sonnet profiles) is a judgment call, not a measurement.
- **It only acts when someone is watching.** In non-interactive runs (`claude -p`, SDK hosts with no surface) it does nothing, since there's nobody to ask.
- **Confirmations are recognised from a word list**: English, plus a few common Italian, Spanish, French and German words. A confirmation in another language is assessed like any request, which costs one classifier call and changes nothing else.
- **The `/mods` switch is read from `~/.claude/mods/switches.json`**, which is how the `/mods` panel stores it today. That file isn't a documented interface.
- **Logs are never deleted.** One small file per session accumulates in the log folder. They hold the start of each request and the working folder, so delete them if that matters to you.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests in `hooks/register.test.ts` play the engine's part and cover the decisions above. To type-check, load the mod once (Claude Code writes its type declarations into `.claude-plugin/types/`), then run `tsc -p .`.

## License

MIT, see [LICENSE](LICENSE).
