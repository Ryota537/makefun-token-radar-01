// Token Radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks the pre-token protocols the snapshot records, strongest implied value first.
// A protocol is pre-token when its record carries no token at all (no market cap, no CoinGecko id,
// no symbol). Wrapped, staked and bridged products of a token that already trades are set aside by
// the same rule the watchlist itself uses (category, name words, version markers, exchange names),
// so the board never ranks a token that already exists under another name. The live-token
// protocols are kept apart and shown with the market's own values, never mixed into the ranking.
//
// Implied value is derived from the snapshot's own figures, in four factors:
//
//   market multiple  M  = the median mcap_usd / tvl_usd of the live-token protocols at or above
//                          the snapshot's own floor ($50M), computed from this snapshot at run
//                          time, never a constant. It is what the market actually pays per dollar
//                          of TVL among tokenised peers of the same size.
//   base             = tvl_usd x M
//   growth           = clamp(change_7d, -50, +100) per cent; growth multiplier
//                      1 + (growth / 100) x 0.6. A week of growth is a signal, not a verdict, so
//                      it can move the value by at most +60% / -30%.
//   age              = days since listed_at (unknown: 365). The age multiplier is a hump, not a
//                      slope: a record builds trust up to about 18 months (0.70 at day 0, rising
//                      to 1.00 at day 540), then the launch premium fades (down to 0.75 past 2,000
//                      days) because a protocol that has run for years with no token has had its
//                      chances to launch and not taken them.
//   breadth          = 1 + 0.02 x min(chains - 1, 5): a protocol live on more chains reaches more
//                      farmers, worth at most +10%.
//
//   implied = max(1, round(base x growth multiplier x age multiplier x breadth multiplier))
//
// No protocol name is ever special-cased: the same function scores every row, and the dashboard
// prints the four factors for each protocol so the number can be checked by hand.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants: the shape of the formula. The multiple itself comes from the data. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  age_peak_days: number;
  age_floor: number;
  age_ceiling_days: number;
  age_faded: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  age_peak_days: 540,
  age_floor: 0.7,
  age_ceiling_days: 2000,
  age_faded: 0.75,
  unknown_age_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_chains: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    market_multiple: number;
    peer_count: number;
    base_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
    chain_multiplier: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row; farm_steps travel with it so the page and the board agree. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  market_multiple: number;
  base_value_usd: number;
  growth_multiplier: number;
  age_multiplier: number;
  chain_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  market_multiple: number;
  market_multiple_full: number;
  peer_count: number;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The market multiple: the median market-cap-per-TVL of the live-token protocols at or above the
 * snapshot's floor, the like-for-like peer set. Returns 0 when the snapshot carries no such peer.
 */
export function marketMultiple(snapshot: Snapshot): { multiple: number; peers: number } {
  const ratios = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd >= snapshot.floor_usd && p.category !== 'CEX')
    .map((p) => p.mcap_usd! / p.tvl_usd)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return { multiple: 0, peers: 0 };
  const mid = Math.floor(ratios.length / 2);
  const multiple = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { multiple, peers: ratios.length };
}

/** The age multiplier's hump: trust builds to the peak, then the launch premium fades. */
export function ageMultiplier(age: number | null, model: ModelConstants): number {
  const a = age ?? model.unknown_age_days;
  if (a <= 0) return model.age_floor;
  if (a < model.age_peak_days) return model.age_floor + (1 - model.age_floor) * (a / model.age_peak_days);
  const past = Math.min(1, (a - model.age_peak_days) / (model.age_ceiling_days - model.age_peak_days));
  return 1 - (1 - model.age_faded) * past;
}

/** The chain-breadth multiplier: more chains, a little more reach, capped. */
export function chainMultiplier(chains: string[], model: ModelConstants): number {
  return 1 + model.breadth_per_chain * Math.min(Math.max(chains.length - 1, 0), model.breadth_max_chains);
}

/** The four factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiple: number,
  model: ModelConstants,
): { implied: number; base: number; growthPct: number; growthMult: number; ageMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageMult = ageMultiplier(age, model);
  const chainMult = chainMultiplier(protocol.chains, model);
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * ageMult * chainMult));
  return { implied, base: Math.round(base), growthPct, growthMult, ageMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchanges whose name at the start of a protocol's name marks it as that exchange's product. */
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged
 * product of a token that already trades, by the watchlist's own rule. The watchlist's slugs all
 * pass this rule, so coverage is never gambled on it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const { multiple, peers } = marketMultiple(snapshot);
  if (multiple <= 0) throw new SnapshotError('snapshot.json carries no live-token peer to price TVL against');
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its size.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, below the floor or left off the list.
  // A chosen protocol stays chosen; nothing is hand-picked, nothing is cut by TVL.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiple, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.age,
    token_status: 'pre-token',
    implied_value_usd: s.implied,
    model: {
      market_multiple: round6(multiple),
      peer_count: peers,
      base_value_usd: s.base,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      age_multiplier: round4(s.ageMult),
      chain_multiplier: round4(s.chainMult),
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one farm position costs to open, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

/** What a transaction costs on a chain, from the chain the protocol itself names first. */
function gasNote(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $8 to $15 of gas on Ethereum';
  if (c === 'solana') return 'under $0.10 of gas on Solana';
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'bnb chain' || c === 'avalanche' || c === 'blast' || c === 'mode') {
    return `under $1 of gas on ${chain}`;
  }
  return 'a few dollars of gas';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('leveraged farm') || c.includes('yield')) return `Deposit $${capital} into a ${name} strategy on ${chain} and let it compound.`;
  if (c.includes('basis')) return `Deposit $${capital} into a ${name} basis vault on ${chain} and hold the vault token.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset through ${name} on ${chain} and hold it.`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one position on a ${name} market.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('payment') || c.includes('card')) return `Route $${capital} through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index token on ${chain} and hold it.`;
  if (c.includes('governance')) return `Deposit $${capital} into ${name} on ${chain} and vote in its next proposal.`;
  if (c.includes('otc')) return `Complete one $${capital} trade on the ${name} marketplace on ${chain}.`;
  if (c.includes('btc') || c.includes('bitcoin')) return `Mint $${capital} of the BTC-backed asset through ${name} on ${chain} and hold it.`;
  if (c.includes('farm')) return `Stake $${capital} of liquidity in the ${name} farm on ${chain}.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${chain} and use it inside ${name}'s own app.`;
  if (c.includes('rate')) return `Open a $${capital} rate position on ${name} and hold it through one reset.`;
  if (c.includes('cedefi')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The second, recurring action that keeps the position qualifying, by category family. */
function recurringFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $10 against the deposit and repay it the same week, so the position shows both sides of the market.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Swap $10 through the pool once a week and add the fees back to the position.`;
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('curator') || c.includes('allocator') || c.includes('yield aggregator') || c.includes('yield')) return `Top up the vault by $10 once a week and check that its allocation is still earning.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('basis')) return `Roll the hedge once a week and keep the margin above the maintenance level.`;
  if (c.includes('staking') || c.includes('restak')) return `Restake the rewards once a week instead of letting them sit idle.`;
  if (c.includes('governance')) return `Vote in every proposal while the position is open, and keep the vote receipts.`;
  if (c.includes('prediction')) return `Settle one small market a week and keep the position history visible.`;
  if (c.includes('rwa')) return `Claim the yield once a week and keep the asset in the same wallet.`;
  if (c.includes('payment') || c.includes('card')) return `Make one real payment a week through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Keep the policy funded and file no claim unless the cover triggers.`;
  return `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list
 * of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasNote(chain);
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: recurringFor(p, capital, chain),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js; the farm plan travels with it, so page and board agree. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    market_multiple: row.model.market_multiple,
    base_value_usd: row.model.base_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { multiple, peers } = marketMultiple(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    market_multiple: round6(multiple),
    market_multiple_full: multiple,
    peer_count: peers,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
