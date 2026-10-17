// Radar de Valor Live — compara odds ao vivo de cada casa com a Pinnacle (ou o consenso do mercado)
// Corre em Bun (Railway Function). Variáveis: ODDS_API_KEY, ACCESS_CODE, REGIONS, CACHE_SECONDS, SOCCER_LEAGUES, SHOW_SCORES

const KEY = Bun.env.ODDS_API_KEY || "";
const CODE = Bun.env.ACCESS_CODE || "";
const API = "https://api.the-odds-api.com/v4";
const REGIONS = Bun.env.REGIONS || "eu";
const CACHE_MS = Math.max(20, Number(Bun.env.CACHE_SECONDS || 60)) * 1000;
const SHOW_SCORES = (Bun.env.SHOW_SCORES || "1") === "1";
const SOCCER = (Bun.env.SOCCER_LEAGUES ||
  "soccer_epl,soccer_spain_la_liga,soccer_germany_bundesliga,soccer_italy_serie_a,soccer_france_ligue_one,soccer_portugal_primeira_liga,soccer_uefa_champs_league,soccer_uefa_europa_league,soccer_netherlands_eredivisie")
  .split(",").map((s) => s.trim()).filter(Boolean);
const BASKET = ["basketball_nba", "basketball_euroleague"];
const LIVE_WINDOW_MS = 5 * 3600 * 1000;

type Outcome = { name: string; price: number; point?: number };
type Market = { key: string; last_update?: string; outcomes: Outcome[] };
type Bookmaker = { key: string; title: string; last_update?: string; markets: Market[] };
type Ev = { id: string; sport_key: string; sport_title: string; commence_time: string; home_team: string; away_team: string; bookmakers?: Bookmaker[] };
type Sport = { key: string; group: string; title: string; active: boolean; has_outrights: boolean };

let quota: { remaining: number | null; used: number | null } = { remaining: null, used: null };

async function api(path: string, params: Record<string, string> = {}): Promise<{ data: any; cost: number }> {
  const u = new URL(API + path);
  u.searchParams.set("apiKey", KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const rem = r.headers.get("x-requests-remaining");
  if (rem !== null) quota = { remaining: Number(rem), used: Number(r.headers.get("x-requests-used")) };
  const cost = Number(r.headers.get("x-requests-last") || 0);
  if (!r.ok) throw new Error("The Odds API " + r.status + ": " + (await r.text()).slice(0, 200));
  return { data: await r.json(), cost };
}

function sportKind(key: string): "futebol" | "basquetebol" | "tenis" {
  if (key.startsWith("soccer_")) return "futebol";
  if (key.startsWith("basketball_")) return "basquetebol";
  return "tenis";
}
function marketsFor(key: string) {
  const k = sportKind(key);
  return k === "tenis" ? "h2h" : k === "futebol" ? "h2h,totals" : "h2h,totals,spreads";
}

let sportsCache: { t: number; list: Sport[] } = { t: 0, list: [] };
async function trackedSports(): Promise<Sport[]> {
  if (Date.now() - sportsCache.t > 30 * 60 * 1000) {
    const { data } = await api("/sports");
    sportsCache = { t: Date.now(), list: data };
  }
  return sportsCache.list.filter((s) => s.active && !s.has_outrights &&
    (SOCCER.includes(s.key) || BASKET.includes(s.key) || s.key.startsWith("tennis_")));
}

// ---------- análise de valor ----------
const fmtPt = (p: number) => (p > 0 ? "+" : "") + String(p).replace(".", ",");

function devig(prices: number[]) {
  const inv = prices.map((p) => 1 / p);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}

export function analyze(ev: Ev, now = Date.now()) {
  const kind = sportKind(ev.sport_key);
  // grupo de mercado -> casa -> {title, lu, prices: Map<seleção, odd>}
  const groups = new Map<string, { label: string; need: number; books: Map<string, { title: string; lu: number; prices: Map<string, number> }> }>();
  const put = (gk: string, label: string, need: number, b: Bookmaker, lu: number, sel: string, price: number) => {
    if (!(price > 1)) return;
    if (!groups.has(gk)) groups.set(gk, { label, need, books: new Map() });
    const g = groups.get(gk)!;
    if (!g.books.has(b.key)) g.books.set(b.key, { title: b.title, lu, prices: new Map() });
    g.books.get(b.key)!.prices.set(sel, price);
  };
  for (const b of ev.bookmakers || []) {
    for (const m of b.markets || []) {
      const lu = Date.parse(m.last_update || b.last_update || "") || now;
      if (m.key === "h2h") {
        for (const o of m.outcomes) {
          const sel = o.name === "Draw" ? "Empate" : o.name;
          put("h2h", kind === "futebol" ? "Resultado (1X2)" : "Vencedor", kind === "futebol" ? 3 : 2, b, lu, sel, o.price);
        }
      } else if (m.key === "totals") {
        for (const o of m.outcomes) {
          if (o.point == null) continue;
          const sel = (o.name === "Over" ? "Mais de " : "Menos de ") + String(o.point).replace(".", ",");
          put("totals|" + o.point, "Total " + String(o.point).replace(".", ","), 2, b, lu, sel, o.price);
        }
      } else if (m.key === "spreads") {
        const hp = m.outcomes.find((o) => o.name === ev.home_team)?.point;
        if (hp == null) continue;
        for (const o of m.outcomes) {
          if (o.point == null) continue;
          put("spreads|" + hp, "Handicap", 2, b, lu, o.name + " " + fmtPt(o.point), o.price);
        }
      }
    }
  }

  const opps: any[] = [];
  for (const [gk, g] of groups) {
    const complete = [...g.books.entries()].filter(([, l]) => l.prices.size === g.need);
    if (!complete.length) continue;
    const sels = [...complete[0][1].prices.keys()];
    let fair = new Map<string, number>();
    let ref = "";
    let refLu = now;
    const pin = complete.find(([k]) => k === "pinnacle");
    if (pin) {
      const p = devig(sels.map((s) => pin[1].prices.get(s)!));
      sels.forEach((s, i) => fair.set(s, p[i]));
      ref = "Pinnacle";
      refLu = pin[1].lu;
    } else {
      const others = complete.filter(([k]) => !k.startsWith("betfair_ex") || true);
      if (others.length < 3) continue;
      const sum = new Map<string, number>();
      for (const [, l] of others) {
        if (!sels.every((s) => l.prices.has(s))) continue;
        const p = devig(sels.map((s) => l.prices.get(s)!));
        sels.forEach((s, i) => sum.set(s, (sum.get(s) || 0) + p[i]));
      }
      const n = others.length;
      sels.forEach((s) => fair.set(s, (sum.get(s) || 0) / n));
      ref = "Consenso de " + n + " casas";
      refLu = Math.max(...others.map(([, l]) => l.lu));
    }
    for (const [bk, l] of g.books) {
      if (bk === "pinnacle") continue;
      for (const [sel, price] of l.prices) {
        const p = fair.get(sel);
        if (!p) continue;
        const evv = price * p - 1;
        if (evv <= 0) continue;
        opps.push({
          eventId: ev.id, sport: kind, league: ev.sport_title,
          match: ev.home_team + " – " + ev.away_team, start: ev.commence_time,
          market: g.label, marketKey: gk.split("|")[0], selection: sel,
          book: l.title, bookKey: bk, price, prob: p, fairOdd: 1 / p, ev: evv, ref,
          ageSec: Math.max(0, Math.round((now - l.lu) / 1000)),
          lagSec: Math.round((refLu - l.lu) / 1000),
          suspect: evv > 0.25,
        });
      }
    }
  }
  return opps;
}

// ---------- recolha ----------
let cache: { t: number; data: any } | null = null;
let pending: Promise<any> | null = null;

async function collect() {
  const now = Date.now();
  const sports = await trackedSports();
  const evLists = await Promise.all(sports.map(async (s) => {
    try {
      const { data } = await api("/sports/" + s.key + "/events"); // não gasta créditos
      return { s, live: (data as Ev[]).filter((e) => { const t = Date.parse(e.commence_time); return t <= now && now - t < LIVE_WINDOW_MS; }) };
    } catch { return { s, live: [] as Ev[] }; }
  }));
  const liveSports = evLists.filter((x) => x.live.length);
  let cost = 0;
  const errors: string[] = [];
  const opps: any[] = [];
  const live: any[] = [];
  const books = new Map<string, string>();
  await Promise.all(liveSports.map(async ({ s, live: evs }) => {
    const liveIds = new Set(evs.map((e) => e.id));
    try {
      const [odds, scores] = await Promise.all([
        api("/sports/" + s.key + "/odds", { regions: REGIONS, markets: marketsFor(s.key), oddsFormat: "decimal" }),
        SHOW_SCORES && sportKind(s.key) !== "tenis" ? api("/sports/" + s.key + "/scores").catch(() => ({ data: [], cost: 0 })) : Promise.resolve({ data: [], cost: 0 }),
      ]);
      cost += odds.cost + scores.cost;
      const sc = new Map<string, any>();
      for (const e of scores.data as any[]) if (e.scores) sc.set(e.id, e.scores);
      for (const e of odds.data as Ev[]) {
        if (!liveIds.has(e.id)) continue;
        for (const b of e.bookmakers || []) books.set(b.key, b.title);
        const s2 = sc.get(e.id);
        const score = s2 ? [e.home_team, e.away_team].map((n) => s2.find((x: any) => x.name === n)?.score ?? "–").join("–") : null;
        live.push({ id: e.id, sport: sportKind(e.sport_key), league: e.sport_title, home: e.home_team, away: e.away_team, start: e.commence_time, score, books: (e.bookmakers || []).length });
        for (const o of analyze(e, now)) opps.push({ ...o, score });
      }
    } catch (err: any) { errors.push(s.title + ": " + err.message); }
  }));
  opps.sort((a, b) => b.ev - a.ev);
  return {
    mode: "live", updatedAt: new Date().toISOString(), quota, cost, regions: REGIONS,
    trackedCount: sports.length, live, opps, books: [...books].map(([key, title]) => ({ key, title })).sort((a, b) => a.title.localeCompare(b.title)), errors,
  };
}

async function getData() {
  if (cache && Date.now() - cache.t < CACHE_MS) return cache.data;
  // proteção de créditos: com poucos créditos, só atualiza de 15 em 15 minutos
  if (cache && quota.remaining !== null && quota.remaining < 40 && Date.now() - cache.t < 15 * 60 * 1000) return { ...cache.data, lowQuota: true };
  if (!pending) pending = collect().then((d) => { cache = { t: Date.now(), data: d }; return d; }).finally(() => { pending = null; });
  return pending;
}

// ---------- dados de exemplo ----------
function demo() {
  const now = Date.now();
  const mk = (id: string, sport_key: string, sport_title: string, mins: number, home: string, away: string, bms: [string, string, Market[]][]): Ev => ({
    id, sport_key, sport_title, commence_time: new Date(now - mins * 60000).toISOString(), home_team: home, away_team: away,
    bookmakers: bms.map(([key, title, markets]) => ({ key, title, markets: markets.map((m) => ({ ...m, last_update: new Date(now - 15000).toISOString() })) })),
  });
  const h2h3 = (a: number, d: number, b: number, H: string, A: string): Market => ({ key: "h2h", outcomes: [{ name: H, price: a }, { name: "Draw", price: d }, { name: A, price: b }] });
  const h2h2 = (a: number, b: number, H: string, A: string): Market => ({ key: "h2h", outcomes: [{ name: H, price: a }, { name: A, price: b }] });
  const tot = (pt: number, o: number, u: number): Market => ({ key: "totals", outcomes: [{ name: "Over", price: o, point: pt }, { name: "Under", price: u, point: pt }] });
  const evs = [
    mk("d1", "soccer_portugal_primeira_liga", "Primeira Liga", 62, "Equipa Norte", "Equipa Sul", [
      ["pinnacle", "Pinnacle", [h2h3(1.62, 3.9, 6.4, "Equipa Norte", "Equipa Sul"), tot(2.5, 2.25, 1.68)]],
      ["betclic", "Betclic", [h2h3(1.70, 3.6, 5.8, "Equipa Norte", "Equipa Sul"), tot(2.5, 2.15, 1.65)]],
      ["unibet_eu", "Unibet", [h2h3(1.60, 3.8, 6.9, "Equipa Norte", "Equipa Sul"), tot(2.5, 2.38, 1.55)]],
    ]),
    mk("d2", "basketball_euroleague", "Euroleague", 30, "Clube Azul", "Clube Verde", [
      ["pinnacle", "Pinnacle", [h2h2(1.55, 2.55, "Clube Azul", "Clube Verde"), tot(161.5, 1.90, 1.92)]],
      ["williamhill", "William Hill", [h2h2(1.50, 2.75, "Clube Azul", "Clube Verde"), tot(161.5, 1.87, 1.87)]],
      ["betsson", "Betsson", [h2h2(1.58, 2.45, "Clube Azul", "Clube Verde"), tot(161.5, 1.98, 1.80)]],
    ]),
    mk("d3", "tennis_atp_example", "ATP (exemplo)", 45, "Jogador A", "Jogador B", [
      ["pinnacle", "Pinnacle", [h2h2(1.40, 3.05, "Jogador A", "Jogador B")]],
      ["marathonbet", "Marathonbet", [h2h2(1.36, 3.35, "Jogador A", "Jogador B")]],
      ["sport888", "888sport", [h2h2(1.44, 2.80, "Jogador A", "Jogador B")]],
    ]),
  ];
  const scores: Record<string, string | null> = { d1: "1–1", d2: "48–44", d3: null };
  const opps = evs.flatMap((e) => analyze(e, now).map((o) => ({ ...o, score: scores[e.id] }))).sort((a, b) => b.ev - a.ev);
  const books = new Map<string, string>();
  evs.forEach((e) => e.bookmakers!.forEach((b) => books.set(b.key, b.title)));
  return {
    mode: KEY ? "demo" : "nokey", updatedAt: new Date().toISOString(), quota, cost: 0, regions: REGIONS, trackedCount: 0,
    live: evs.map((e) => ({ id: e.id, sport: sportKind(e.sport_key), league: e.sport_title, home: e.home_team, away: e.away_team, start: e.commence_time, score: scores[e.id], books: e.bookmakers!.length })),
    opps, books: [...books].map(([key, title]) => ({ key, title })), errors: [],
  };
}

// ---------- servidor ----------
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const PAGE = await Bun.file(new URL("./page.html", import.meta.url)).text();

Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/data") {
      const code = req.headers.get("x-code") || url.searchParams.get("code") || "";
      if (CODE && code !== CODE) return json({ error: "codigo" }, 401);
      if (!KEY || url.searchParams.get("demo") === "1") return json(demo());
      try { return json(await getData()); }
      catch (e: any) { return json({ error: e.message, quota }, 502); }
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log("Radar de Valor Live a correr. Chave API:", KEY ? "definida" : "em falta (modo exemplo)");

