# Instructions for Claude in this repository

## Usage budget (owner's standing rule, 2026-11-26)

The owner's usage budget is limited. On 2026-11-26 a session ran five background agents in parallel on the top-tier
model and used most of the weekly budget in a few hours. The owner's instruction, in their words: "Don't ever do this
again", "From now on, always code with cheaper agents, and you as Fable only do the planning."

Rules that follow from it:

- The top-tier session model plans, designs, reviews and talks to the owner. It does not do the bulk coding itself.
- Coding is delegated to a cheaper model: pass `model: "sonnet"` (or `"haiku"` for trivial work) on every Agent call.
  Never spawn an agent that inherits the top-tier model, and never use `subagent_type: "fork"` for coding.
- Parallel background agents are allowed again, but ONLY on cheaper models (owner, later on 2026-11-26: "start as many
  agents as u want as long as fable is doing research and delegation and actual coding etc happens via cheaper models
  best fit for each task"). Pick the cheapest model that fits each task. Run in parallel only work that is really
  independent (different files), keep the number modest, and never run a parallel agent on the top-tier model. No
  workflows unless the owner asks for them.
- Before starting anything large (a multi-hour feature, several features at once), say so and give a rough size, then
  wait for the owner's go-ahead.
- Keep agent briefs narrow, and tell agents to run targeted tests only (never the whole vitest suite).
- If the owner asks about usage, answer plainly what is running and on which model.

## How features must be designed (owner's standing rule, 2026-11-27)

The owner is an artist, not a programmer, and works mostly on a phone. After a Physics node shipped with about twenty
outputs and no obvious next step, the owner said: "when you do stuff, also think over … not just how it's gonna
function on a software side, but on how it's gonna be used by me or other users. I have no clue what this node does
currently, and what properties of it I have to plug into what things."

Rules that follow from it (apply them in every brief to a coding agent):

- Design the first use before the internals: what does a first-time user see when the node is added, and what is the
  one obvious next step? If the answer is "wire six things", redesign.
- A new node must show something useful as soon as it is added, with the fewest possible wires. Prefer a control on the
  thing the user already has (a switch in the object's inspector that sets everything up) over a hub node to wire.
- Keep the node's face small: show only the sockets in use; hide advanced inputs and outputs until asked for; one wire
  per idea (bundle values that always travel together).
- Every node explains itself in plain words: a `guide` ("How to use") entry, an unwired required input says so on the
  node, and the summary line states what the node is doing or what it is missing.
- Offer one-step setups ("do it for me") for common chains, and a template.
- No jargon in the UI.
- Before reporting, the agent must open the feature in a real page at desktop and phone size, screenshot it, and judge
  the screenshot as a newcomer would. Reviewing those screenshots is part of the top-tier model's review.
- When reporting to the owner, say how to use the feature in steps, not how it works inside.

## Wires are the only connections (owner's standing rule, 2026-11-27)

A node is affected only by what is wired into it, directly or through the nodes upstream of it. This is the contract in
docs/ENGINE.md ("A node … knows nothing else: not the graph, not other nodes") and the owner relies on it: several
cameras, each with its own objects, field of view and light, layered freely. When a proposal made the World AR Camera
apply to every 3D object automatically, the owner rejected it: "use only on all 3d objects somehow wired through this
camera", "this should be the rule because of the downstream node rules we set up early on."

- Never add implicit or global behaviour (a default camera, a scene-wide light, a node that changes others it is not
  wired to). No hidden connections.
- To save the user from dragging wires, make REAL wires for them: tick lists, dropdowns and one-step setups that create
  or move visible wires in one undo step.
- Values that always travel together ride on one wire (the camera carries its light and floor; a Motion wire carries
  the Physics camera), so the effect still follows the wiring.
