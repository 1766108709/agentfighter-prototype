# Triad real-time black-box evaluation

## Current status

The playable roster now contains one fighter only: `vanguard` (苍流). Both
candidate and opponent use the same fighter, while their Agent strategies may
still differ.

The previous published win rates were measured under the retired dual-roster
rules. They are not comparable to the single-fighter rules and must not be used
as evidence for the current build. A fresh training run and a fresh frozen
holdout run are required before a new champion claim is published.

## Current evaluation contract

- Module: `src/triad-champion-agent-alt.js`
- Fighter: `vanguard` (苍流) on both sides
- Rules: hard difficulty, real-time observation, BO3, 60-second rounds,
  alternating physical sides
- Candidate input: same-frame public `ObservationV1` only
- Candidate output: strict `ActionV1` only
- Opponents: `balanced`, `pressure`, and `zoner`
- Acceptance target: at least 60% strict win rate against each opponent

## Clean-room controls

- The harness never passes opponent preset, label, identity, hidden intent,
  debug state, raw game state, or replay internals to the candidate.
- Both participants receive same-frame public observations:
  `perception.delayFrames = 0` and
  `perception.opponentFrame = observation.frame`.
- The candidate dependency graph contains only the candidate, the public
  Vanguard moveset, and public move data.
- Randomized opponent names, reset identities, and seeds produce identical
  actions for identical public observations.
- No dynamic import, `require`, filesystem, network, process, or environment
  access exists in the candidate dependency graph.

## Rebaseline procedure

First verify the clean-room contract:

```bash
node tests/triad-champion-agent-alt.mjs
node tests/triad-alt-cleanroom.mjs
```

Then tune only on the training split:

```bash
node scripts/gauntlet-eval.mjs \
  --candidate ./src/triad-champion-agent-alt.js \
  --samples 40 --split training --seed 10000 --format text
```

After freezing the candidate hash, run the holdout once and record the result
in this document:

```bash
node scripts/gauntlet-eval.mjs \
  --candidate ./src/triad-champion-agent-alt.js \
  --samples 100 --split holdout --seed 70000 --format text
```
