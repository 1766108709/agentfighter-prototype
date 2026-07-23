# Triad Champion black-box evaluation

## Frozen candidate

- Module: `src/triad-champion-agent-alt.js`
- SHA-256: `798c3a17845a8123c0deac9df77aca5b81b0e8cbe4095b4264daa6ad46ec6bb1`
- Rules: hard difficulty, 12-frame opponent observation delay, BO3, 60-second rounds, alternating physical sides
- Candidate input: public `ObservationV1` only
- Candidate output: strict `ActionV1` only

The candidate was frozen before the holdout run. Training used seeds in the
10000-29999 split. The only holdout run used seed 70000.

## Training

| Seed | Opponent | Matches | W-L-D | Strict win rate |
| ---: | --- | ---: | ---: | ---: |
| 10000 | balanced | 40 | 31-9-0 | 77.5% |
| 10000 | pressure | 40 | 40-0-0 | 100% |
| 10000 | zoner | 40 | 34-6-0 | 85% |
| 10200 | balanced | 40 | 29-11-0 | 72.5% |
| 10200 | pressure | 40 | 40-0-0 | 100% |
| 10200 | zoner | 40 | 32-8-0 | 80% |

Combined training: balanced 75%, pressure 100%, zoner 82.5%; overall
206-34-0 (85.83%).

## Holdout

One run, seed 70000, 100 matches per opponent:

| Opponent | Matches | W-L-D | Strict win rate |
| --- | ---: | ---: | ---: |
| balanced | 100 | 74-26-0 | 74% |
| pressure | 100 | 100-0-0 | 100% |
| zoner | 100 | 85-15-0 | 85% |

Overall holdout: 259-41-0 (86.33%). All three opponent-level targets are
strictly above 60%. The weakest individual character leg was candidate
Vanguard versus balanced Ember at 29-21 (58%); it is reported explicitly even
though the acceptance criterion is per opponent type across both equal legs.

## Clean-room controls

- The harness never passes opponent preset, label, identity, hidden intent,
  debug state, raw game state, or replay internals to the candidate.
- Both participants are platform-enforced at a 12-frame opponent observation
  delay.
- The candidate dependency graph contains only the candidate, the two public
  character movesets, and public move data.
- Randomized opponent names, templates, reset identities, and seeds produce
  identical actions for identical public observations.
- No dynamic import, `require`, filesystem, network, process, or environment
  access exists in the candidate dependency graph.

## Reproduce

```bash
node tests/triad-champion-agent-alt.mjs
node tests/triad-alt-cleanroom.mjs
node scripts/gauntlet-eval.mjs \
  --candidate ./src/triad-champion-agent-alt.js \
  --samples 100 --split holdout --seed 70000 --format text
npm test
```
