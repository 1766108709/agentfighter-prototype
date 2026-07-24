# Triad real-time black-box evaluation

## Frozen candidate

- Module: `src/triad-champion-agent-alt.js`
- SHA-256: `798c3a17845a8123c0deac9df77aca5b81b0e8cbe4095b4264daa6ad46ec6bb1`
- Rules: hard difficulty, real-time observation, BO3, 60-second rounds, alternating physical sides
- Candidate input: same-frame public `ObservationV1` only
- Candidate output: strict `ActionV1` only

The candidate was frozen before the holdout run. Training used seeds in the
10000-29999 split. The only holdout run used seed 70000.

## Training

### Seed 10000

| Opponent | Matches | W-L-D | Strict win rate |
| --- | ---: | ---: | ---: |
| balanced | 40 | 27-13-0 | 67.5% |
| pressure | 40 | 40-0-0 | 100% |
| zoner | 40 | 20-20-0 | 50% |

Overall: 87-33-0 (72.5%).

| Opponent | Candidate template | Opponent template | Matches | W-L-D | Strict win rate |
| --- | --- | --- | ---: | ---: | ---: |
| balanced | Vanguard | Ember | 20 | 7-13-0 | 35% |
| balanced | Ember | Vanguard | 20 | 20-0-0 | 100% |
| pressure | Vanguard | Ember | 20 | 20-0-0 | 100% |
| pressure | Ember | Vanguard | 20 | 20-0-0 | 100% |
| zoner | Vanguard | Ember | 20 | 20-0-0 | 100% |
| zoner | Ember | Vanguard | 20 | 0-20-0 | 0% |

### Seed 10200

| Opponent | Matches | W-L-D | Strict win rate |
| --- | ---: | ---: | ---: |
| balanced | 40 | 31-9-0 | 77.5% |
| pressure | 40 | 40-0-0 | 100% |
| zoner | 40 | 17-23-0 | 42.5% |

Overall: 88-32-0 (73.33%).

| Opponent | Candidate template | Opponent template | Matches | W-L-D | Strict win rate |
| --- | --- | --- | ---: | ---: | ---: |
| balanced | Vanguard | Ember | 20 | 11-9-0 | 55% |
| balanced | Ember | Vanguard | 20 | 20-0-0 | 100% |
| pressure | Vanguard | Ember | 20 | 20-0-0 | 100% |
| pressure | Ember | Vanguard | 20 | 20-0-0 | 100% |
| zoner | Vanguard | Ember | 20 | 17-3-0 | 85% |
| zoner | Ember | Vanguard | 20 | 0-20-0 | 0% |

### Combined training

| Opponent | Matches | W-L-D | Strict win rate |
| --- | ---: | ---: | ---: |
| balanced | 80 | 58-22-0 | 72.5% |
| pressure | 80 | 80-0-0 | 100% |
| zoner | 80 | 37-43-0 | 46.25% |

Combined overall: 175-65-0 (72.92%).

## Holdout

One run, seed 70000, 100 matches per opponent:

| Opponent | Matches | W-L-D | Strict win rate |
| --- | ---: | ---: | ---: |
| balanced | 100 | 68-32-0 | 68% |
| pressure | 100 | 100-0-0 | 100% |
| zoner | 100 | 44-56-0 | 44% |

Overall holdout: 212-88-0 (70.67%).

| Opponent | Candidate template | Opponent template | Matches | W-L-D | Strict win rate |
| --- | --- | --- | ---: | ---: | ---: |
| balanced | Vanguard | Ember | 50 | 18-32-0 | 36% |
| balanced | Ember | Vanguard | 50 | 50-0-0 | 100% |
| pressure | Vanguard | Ember | 50 | 50-0-0 | 100% |
| pressure | Ember | Vanguard | 50 | 50-0-0 | 100% |
| zoner | Vanguard | Ember | 50 | 44-6-0 | 88% |
| zoner | Ember | Vanguard | 50 | 0-50-0 | 0% |

Under the real-time rules, the candidate is strictly above 60% against
balanced and pressure, but not against zoner. It therefore does not satisfy the
three-opponent acceptance target. The weakest character leg is candidate Ember
versus zoner Vanguard at 0-50 (0%); candidate Vanguard versus balanced Ember is
also below 60% at 18-32 (36%).

## Clean-room controls

- The harness never passes opponent preset, label, identity, hidden intent,
  debug state, raw game state, or replay internals to the candidate.
- Both participants receive a same-frame public observation:
  `perception.delayFrames = 0` and
  `perception.opponentFrame = observation.frame`.
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
  --samples 40 --split training --seed 10000 --format text
node scripts/gauntlet-eval.mjs \
  --candidate ./src/triad-champion-agent-alt.js \
  --samples 40 --split training --seed 10200 --format text
node scripts/gauntlet-eval.mjs \
  --candidate ./src/triad-champion-agent-alt.js \
  --samples 100 --split holdout --seed 70000 --format text
npm test
```
