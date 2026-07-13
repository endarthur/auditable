# @gcu/dispatch — natural-language tool-call dispatch, session-trained

**Status:** v0.1 (folded in from the `gcu-dispatch` incubator, 2026-07-13)
**Depends on:** nothing (zero-dep, browser-pure ESM)

One utterance in, one routed, explainable tool call out. No conversation,
no agent loop, no network, no shipped model: the dispatcher is **trained
in the tab, from the session's own vocabulary, in under a second**, and
discarded with the tab. What ships is ~30 KB of banks, kinds, and two
linear learners.

## Provenance (one paragraph of history)

The incubator (`../gcu-dispatch`, kept as the lab) ran the experiment:
a 26M tool-calling transformer (Cactus Needle) scored 4/24 stock and
3/24 after a teacher finetune on a frozen yardstick; a Snips-shaped
resolver — averaged-perceptron intent + structured-perceptron slot
tagger + gazetteers + a deterministic assembler — scored 50/52 on the
tripled toolset, training in 0.8 s. The resolver ladder inverted. This
package is that winner, generalized. Full record:
`gcu-dispatch/eval/runs/2026-07-13-P2-comparison-report.md`.

## Architecture

```
        session (columns, categories, layers)
                    │ deriveVocab
                    ▼
tools (declarative) ──▶ gen (banks × kinds, seeded) ──▶ corpus
                    │                                     │ align (answer-first)
                    │                                     ▼
                    │                                   train (perceptrons, <1 s)
                    ▼                                     │
        createDispatcher({ vocab, tools, weights }) ◀─────┘
                    │
   dispatch(query, { surface }) → { calls, intent, margin, tags }
```

- **Intent**: averaged multiclass perceptron over unigrams/bigrams +
  gazetteer + STRUCTURAL features (has-comparison, has-layer, has-unit —
  the hand-computed nonlinearity that makes a linear model sufficient).
  `REFUSE` is a first-class intent.
- **Slots**: averaged structured perceptron (CRF-class), 10 tags
  (O COL OP VAL CAT RNG POS THICK ID LAYER), Viterbi decode.
- **Assembly**: deterministic, per KIND (below) — tags + lexicons →
  arguments; failure → empty calls (degrade to the palette).
- **Gate signal**: intent margin + assembly success (both meaningful,
  unlike a small transformer's logprob).
- **Surface scoping**: `dispatch(q, {surface: 'micro'})` restricts
  candidates to that surface's tools + REFUSE — the shortlister's role.

## The kind contract (the plugin boundary)

Tools are DATA. A host registers declarations; dispatch owns the kind
implementations (render for the corpus, align for training labels,
assemble for inference). Adding a tool to a host never edits dispatch.

Kinds (v0.1): `comparison-filter` · `column-pick` · `axis-position` ·
`axis-pick` · `category-visibility` · `layer-pick` · `layer-action` ·
`lexicon-pick` · `number-arg` · `no-arg`.

```js
{ name: 'micro.filterBlocks', kind: 'comparison-filter',
  nouns: ['blocks', 'the blocks', 'the model'], benchRange: 'BENCH' }
{ name: 'micro.sectionAt', kind: 'axis-position',
  axes: { Z: ['elevation', 'elev', 'horizontal', 'level', 'plan', 'rl'],
          X: ['easting', 'east', 'north-south', 'ns'],
          Y: ['northing', 'north', 'east-west', 'ew'] } }
{ name: 'micro.setColorRamp', kind: 'lexicon-pick', argName: 'preset',
  values: { viridis: ['viridis'], greys: ['greys', 'grayscale'] },
  frames: ['use the {val} ramp', 'switch to {val}', '{val} colors'] }
{ name: 'micro.clearFilter', kind: 'no-arg',
  frames: ['clear the filter', 'remove the filter', 'unfilter'] }
```

Frames are template strings with `{slot}` placeholders — declarations
stay JSON-able (see MCP adoption below). Kind-specific fields are
documented per kind in `src/kinds.js`.

## Session vocabulary

`deriveVocab({ numCols, catCols, catValues, layers, locale })` — the
host maps its live session into synonym pools (a column named FE gets
['FE', 'iron', …] from the element lexicon plus host-supplied aliases;
layers arrive as label→file). NOTHING here is baked: new project, new
vocabulary, retrain — the dispatcher cannot be stale.

`trainSession(vocab, tools, opts)` = generate → align → train in one
call. `opts.excludeTexts` is the eval-contamination guard (a Set of
normalized texts never emitted into the corpus). `opts.seed` for
byte-reproducibility. `opts.extraRefusals` for host-domain negatives.

## Locale

Banks, op-words, units, show/hide verbs, and word-numbers are keyed by
locale (`en` shipped; `pt-BR` is the next bank, not the next feature —
"esconde a canga", "seção na cota 1020" ride the same machinery).

## MCP adoption (designed, not built)

A WebMCP/MCP tool whose inputSchema is rightly shaped maps onto a kind
mechanically: empty properties → `no-arg`; one all-enum string →
`lexicon-pick` (enum values become the lexicon, description feeds
synonyms); one number → `number-arg`; enum'd column + op + value →
`comparison-filter`. `adoptMcpTool(schema, hints?)` would emit a
declaration, with `hints.kind` as the escape hatch for schemas the
heuristic can't type. The registry (numen) stays the source of truth;
dispatch derives, never invents. This is the bridge that makes any
well-shaped MCP surface voice/command-bar-able for free.

## Non-goals (unchanged from the incubator spec)

Multi-step plans, conversational replies, replacing explicit UI. The
palette is the floor: low margin or failed assembly returns `[]`, and
the host shows candidates instead of guessing.

## Roadmap

- pt-BR banks; per-host extra synonyms (au → 'ouro').
- Rung-1 exact layer: normalized-pattern hash of the training corpus
  checked before the classifier (explainable exact hits).
- Gate calibration: margin thresholds fitted per session size.
- A-Bus service + numen registry wiring (the incubator spec's P3).
- micro/lamina integration: command bar + palette degradation.
- `adoptMcpTool` per the section above.
