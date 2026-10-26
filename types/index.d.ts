export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// The level in use, with the model and effort the session had at that moment:
// if they change, the person chose something else with /model or /effort.
export type Choice = {
  level: number
  model: string
  effort: Effort
  name: string
  sessionModel: string
  sessionEffort: Effort | null
}

declare module 'claude-code' {
  interface PluginState {
    'model-advisor': {
      choice: Choice | null
      disabled: boolean
      // The model is decided once, on the first request that brings work.
      decided: boolean
      // How many opening turns were greetings or confirmations: they do not say what the work will be.
      openers: number
      // The level estimated for the previous request: context and hysteresis.
      lastLevel: number | null
      // The session's effort at the last step: the decision is taken before the turn.
      seenEffort: Effort | null
    }
  }
}
