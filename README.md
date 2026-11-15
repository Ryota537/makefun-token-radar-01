# Token Radar — token-radar-01

[![Bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01) [![Rank](https://make.fun/badge/token-radar-01/Ryota537/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01) [![Reward](https://make.fun/badge/token-radar-01/Ryota537/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: it reads a frozen DefiLlama snapshot, ranks the protocols that
record no token by an implied value, and hands in a dashboard with a farm plan for each.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
node tools/validate.mjs out
```

`main.ts` (Node 22, standard library only) writes `board.json`, `data.js`,
`dashboard/`, `screenshots/` and `dossier.json` into the output directory. It is
deterministic: two runs on the same snapshot write byte-identical output.

## The model (radar-2)

`implied = round(tvl_usd x M x growth x age_hump x breadth)`, where

- `M` is the market multiple: the median market-cap-per-TVL of the live-token
  protocols at or above the snapshot's own $50M floor, computed from the snapshot
  at run time (0.082002x from 45 peers on this snapshot), never a constant;
- `growth = 1 + clamp(change_7d, -50, +100) / 100 x 0.6`;
- `age_hump` rises from 0.70 at listing to 1.00 at 540 days, then fades to 0.75
  past 2,000 days: a record builds trust, then the launch premium fades;
- `breadth = 1 + 0.02 x min(chains - 1, 5)`.

The board ranks every rankable pre-token protocol: the 40 watchlist slugs plus
every other pre-token protocol that is not a wrapped, staked or bridged product
of a token that already trades, by the watchlist's own rule. Live-token
protocols are set aside with their market caps shown, never modelled.

Farm plans are derived per protocol from its category, chains, TVL and age:
capital tiers, a category action, a recurring action, a hold window, a
claim-safety step and a log step, each with its cost and time.

## Screenshots

`tools/screenshot.mjs` renders the dashboard in the machine's headless
Chromium over CDP and writes the three views: the board, a protocol's detail
drawer, and a filtered view. The shots in `screenshots/` are those renders.

## Layout

- `main.ts` — entrypoint
- `lib/model.ts` — the model, the board builder and the farm plans
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte from the kit
- `dashboard/` — `index.html`, `app.css`, `app.js` (no network, no framework)
- `screenshots/` — the three rendered views
- `tools/` — `screenshot.mjs` (CDP renders) and `validate.mjs` (local gate re-check)
