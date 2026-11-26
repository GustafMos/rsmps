# Instructions for Claude in this repository

## Usage budget (owner's standing rule, 2026-11-26)

The owner's usage budget is limited. On 2026-11-26 a session ran five background agents in parallel on the top-tier
model and used most of the weekly budget in a few hours. The owner's instruction, in their words: "Don't ever do this
again", "From now on, always code with cheaper agents, and you as Fable only do the planning."

Rules that follow from it:

- The top-tier session model plans, designs, reviews and talks to the owner. It does not do the bulk coding itself.
- Coding is delegated to a cheaper model: pass `model: "sonnet"` (or `"haiku"` for trivial work) on every Agent call.
  Never spawn an agent that inherits the top-tier model, and never use `subagent_type: "fork"` for coding.
- At most ONE background agent at a time. No parallel fan-out and no workflows unless the owner asks for them in that
  message and has been told the rough cost first.
- Before starting anything large (a multi-hour feature, several features at once), say so and give a rough size, then
  wait for the owner's go-ahead.
- Keep agent briefs narrow, and tell agents to run targeted tests only (never the whole vitest suite).
- If the owner asks about usage, answer plainly what is running and on which model.
