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

const PAGE = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Radar de Valor Live</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --bg:#EEF1F4;--surface:#FFFFFF;--ink:#14202E;--muted:#5B6878;--line:#D5DCE4;
  --accent:#C8502A;--accent-ink:#FFFFFF;
  --good:#1D7A4C;--good-bg:#DDF1E6;--warn:#8A5A00;--warn-bg:#FBEFD5;--flat-bg:#E7EBF0;
  --f-display:"Barlow Condensed","Arial Narrow",sans-serif;
  --f-body:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#0F151C;--surface:#17202A;--ink:#E6ECF2;--muted:#93A1B1;--line:#2A3644;
  --accent:#E07148;--accent-ink:#14100E;
  --good:#52C78F;--good-bg:#133325;--warn:#E8B860;--warn-bg:#3A2E14;--flat-bg:#222D39;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--f-body)}
.wrap{max-width:1240px;margin:0 auto;padding-block:max(20px,env(safe-area-inset-top,0px)) 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:16px}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:14px}
h1{font:700 2.3rem/1 var(--f-display);text-transform:uppercase;margin:0;letter-spacing:.01em}
h1 span{color:var(--accent)}
.status{font:500 .82rem var(--f-mono);color:var(--muted);margin-top:6px;display:flex;flex-wrap:wrap;gap:4px 14px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);margin-right:6px;vertical-align:1px}
.dot.off{background:var(--muted)}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
label.f{display:flex;flex-direction:column;gap:4px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
input,select{font:500 .95rem var(--f-mono);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:7px 9px;width:110px}
select{width:auto;max-width:200px}
button{font:600 .9rem var(--f-body);border-radius:6px;padding:8px 14px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border-radius:999px;padding:5px 14px;font:700 1rem var(--f-display);text-transform:uppercase;letter-spacing:.05em;background:transparent}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.banner{border-radius:10px;padding:12px 16px;background:var(--warn-bg);color:var(--warn);font-size:.9rem}
.banner b{color:inherit}
.banner code{font-family:var(--f-mono)}
.best{border-radius:10px;padding:14px 16px;background:var(--flat-bg);display:flex;flex-direction:column;gap:2px}
.best.on{background:var(--accent);color:var(--accent-ink)}
.best .k{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;opacity:.85}
.best .v{font:700 1.55rem/1.15 var(--f-display)}
.best .d{font:500 .88rem var(--f-mono)}
h2{font:700 1.1rem var(--f-display);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:6px 0 0}
.tw{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;min-width:900px;font-variant-numeric:tabular-nums}
th{font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600;text-align:right;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:right;font:500 .9rem var(--f-mono);white-space:nowrap;vertical-align:top}
th.l,td.l{text-align:left}
td.l{font-family:var(--f-body);white-space:normal}
tr:last-child td{border-bottom:0}
.m{font-weight:600}
.s{font-size:.78rem;color:var(--muted)}
.pill{display:inline-block;min-width:66px;text-align:center;padding:2px 8px;border-radius:999px;background:var(--good-bg);color:var(--good)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.tag{font:600 .66rem var(--f-body);text-transform:uppercase;letter-spacing:.06em;padding:1px 6px;border-radius:4px;background:var(--warn-bg);color:var(--warn);margin-left:6px}
.empty{padding:28px 16px;text-align:center;color:var(--muted)}
.games{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.game{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:0}
.game .lg{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.game .tm{font-weight:600}
.game .sc{font:500 1.05rem var(--f-mono);color:var(--accent)}
.notes{font-size:.85rem;color:var(--muted);max-width:80ch;display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--line);padding-top:14px}
.notes p{margin:0}.notes b{color:var(--ink)}
.gate{max-width:360px;margin:12vh auto;display:flex;flex-direction:column;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:22px}
.gate input{width:100%}
[hidden]{display:none!important}
@media (max-width:600px){h1{font-size:1.9rem}input{width:96px}}
</style>
</head>
<body>
<div class="gate" id="gate" hidden>
  <h1>Radar de <span>Valor</span></h1>
  <label class="f" for="code">Código de acesso<input id="code" type="password" autocomplete="current-password"></label>
  <button class="primary" id="enter">Entrar</button>
  <div class="s" id="gateMsg"></div>
</div>
<div class="wrap" id="app" hidden>
<header>
  <div>
    <h1>Radar de <span>Valor</span> Live</h1>
    <div class="status" id="status"></div>
  </div>
  <div class="controls">
    <label class="f" for="bank">Banca (€)<input id="bank" type="number" value="500" min="0" step="10"></label>
    <label class="f" for="minev">EV mínimo (%)<input id="minev" type="number" value="3" min="0" step="0.5"></label>
    <label class="f" for="kf">Kelly (%)<input id="kf" type="number" value="25" min="0" max="100" step="5"></label>
    <label class="f" for="book">Casa<select id="book"><option value="">Todas as casas</option></select></label>
    <label class="f" for="maxodd">Odd máxima<input id="maxodd" type="number" value="10" min="1.1" step="0.5"></label>
    <label class="f" for="auto">Auto<select id="auto"><option value="0">Desligado</option><option value="120">2 min</option><option value="300">5 min</option><option value="600">10 min</option></select></label>
    <button class="primary" id="refresh">Atualizar</button>
  </div>
</header>
<div class="chips" id="chips">
  <button class="chip" data-s="" aria-pressed="true">Todos</button>
  <button class="chip" data-s="futebol" aria-pressed="false">Futebol</button>
  <button class="chip" data-s="basquetebol" aria-pressed="false">Basquetebol</button>
  <button class="chip" data-s="tenis" aria-pressed="false">Ténis</button>
</div>
<div class="banner" id="banner" hidden></div>
<div class="best" id="best"></div>
<h2>Oportunidades</h2>
<div class="tw"><table>
  <thead><tr><th class="l">Jogo</th><th class="l">Mercado</th><th class="l">Casa</th><th>Odd</th><th>Odd justa</th><th>Prob.</th><th>EV</th><th>Stake</th><th class="l">Referência</th></tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<h2>Jogos ao vivo <span id="nlive"></span></h2>
<div class="games" id="games"></div>
<div class="notes">
  <p><b>Como funciona.</b> Para cada jogo ao vivo, a odd justa vem da Pinnacle sem margem. Se a Pinnacle não tiver o mercado, usa-se a média sem margem de pelo menos três casas. Uma oportunidade é uma casa a pagar acima dessa odd justa.</p>
  <p><b>Antes de apostar.</b> Confirma a odd na casa: ao vivo as odds mudam em segundos e os dados chegam com algum atraso. Odds com mais de 60 s ou com EV acima de 25% aparecem assinaladas, porque muitas vezes já não estão disponíveis.</p>
</div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var state={data:null,sport:"",timer:null,left:0};
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}
["bank","minev","kf","maxodd","auto"].forEach(function(k){var v=ls("radar-"+k);if(v!==null&&v!==undefined)$(k).value=v;$(k).addEventListener("input",function(){ls("radar-"+k,$(k).value);render()})});
$("book").addEventListener("change",function(){ls("radar-book",$("book").value);render()});
$("auto").addEventListener("change",function(){ls("radar-auto",$("auto").value);schedule()});
document.querySelectorAll(".chip").forEach(function(b){b.addEventListener("click",function(){state.sport=b.dataset.s;document.querySelectorAll(".chip").forEach(function(x){x.setAttribute("aria-pressed",x===b?"true":"false")});render()})});
$("refresh").addEventListener("click",function(){load()});
$("enter").addEventListener("click",function(){ls("radar-code",$("code").value);load()});
$("code").addEventListener("keydown",function(e){if(e.key==="Enter")$("enter").click()});
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}
function num(id){var v=parseFloat(String($(id).value).replace(",","."));return isNaN(v)?0:v}
function eur(v){return v.toFixed(2).replace(".",",")+" €"}
function pct(v){return (v*100).toFixed(1).replace(".",",")+"%"}
function mins(start){return Math.max(0,Math.round((Date.now()-Date.parse(start))/60000))}
function load(){
  $("refresh").disabled=true;$("refresh").textContent="A atualizar…";
  var demo=location.search.indexOf("demo=1")>=0;
  fetch("/api/data"+(demo?"?demo=1":""),{headers:{"x-code":ls("radar-code")||""}}).then(function(r){
    if(r.status===401){$("app").hidden=true;$("gate").hidden=false;$("gateMsg").textContent=ls("radar-code")?"Código errado.":"";throw null}
    return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Erro "+r.status);return d});
  }).then(function(d){
    $("gate").hidden=true;$("app").hidden=false;state.data=d;fillBooks();render();schedule();
  }).catch(function(e){if(e){$("app").hidden=false;$("gate").hidden=true;showBanner("Não foi possível atualizar: "+esc(e.message)+". Tenta outra vez daqui a pouco.");schedule()}})
  .finally(function(){$("refresh").disabled=false;$("refresh").textContent="Atualizar"});
}
function schedule(){
  clearInterval(state.timer);var s=parseInt($("auto").value,10);if(!s)return;state.left=s;
  state.timer=setInterval(function(){if(document.hidden)return;state.left--;if(state.left<=0){clearInterval(state.timer);load()}else statusLine()},1000);
}
function fillBooks(){
  var sel=$("book"),cur=ls("radar-book")||"onexbet";sel.innerHTML='<option value="">Todas as casas</option>';
  (state.data.books||[]).filter(function(b){return b.key!=="pinnacle"}).forEach(function(b){var o=document.createElement("option");o.value=b.key;o.textContent=b.key==="onexbet"?"1xBet (≈ 22bet)":b.title;sel.appendChild(o)});
  sel.value=cur;if(sel.value!==cur)sel.value="";
}
function showBanner(h){$("banner").innerHTML=h;$("banner").hidden=!h}
function statusLine(){
  var d=state.data;if(!d)return;var t=new Date(d.updatedAt);
  var parts=['<span><span class="dot'+(d.mode==="live"?"":" off")+'"></span>'+(d.mode==="live"?"Ao vivo":"Dados de exemplo")+'</span>',
    "<span>Atualizado "+t.toLocaleTimeString("pt-PT")+"</span>"];
  if(d.quota&&d.quota.remaining!=null)parts.push("<span>Créditos restantes "+d.quota.remaining+(d.cost?" (−"+d.cost+")":"")+"</span>");
  var s=parseInt($("auto").value,10);if(s&&state.left>0)parts.push("<span>Próxima em "+state.left+" s</span>");
  $("status").innerHTML=parts.join("");
}
function render(){
  var d=state.data;if(!d)return;statusLine();
  if(d.mode==="nokey")showBanner("<b>Modo exemplo.</b> Os jogos e odds abaixo são inventados para mostrar como funciona. Falta a chave da The Odds API na variável <code>ODDS_API_KEY</code> do servidor.");
  else if(d.mode==="demo")showBanner("<b>Modo exemplo</b> (abriste com ?demo=1).");
  else if(d.lowQuota)showBanner("<b>Poucos créditos na API.</b> Para os poupar, os dados só atualizam de 15 em 15 minutos.");
  else if(d.errors&&d.errors.length)showBanner("Algumas competições falharam: "+esc(d.errors.join(" · ")));
  else showBanner("");
  var bank=num("bank"),thr=num("minev")/100,kf=Math.min(1,Math.max(0,num("kf")/100)),book=$("book").value;
  var rows=(d.opps||[]).filter(function(o){return o.ev>=thr&&o.price<=(num("maxodd")||99)&&(!state.sport||o.sport===state.sport)&&(!book||o.bookKey===book)});
  var html=rows.map(function(o){
    var k=(o.price*o.prob-1)/(o.price-1),stake=Math.max(0,k)*kf*bank;
    var stale=o.ageSec>60||o.lagSec>45;
    var flags=(o.suspect?'<span class="tag">Confirmar</span>':"")+(stale?'<span class="tag">Odd antiga</span>':"");
    return "<tr><td class=l><div class=m>"+esc(o.match)+"</div><div class=s>"+esc(o.league)+" · "+(o.score?esc(o.score)+" · ":"")+mins(o.start)+"′ desde o início</div></td>"+
      "<td class=l><div class=m>"+esc(o.selection)+"</div><div class=s>"+esc(o.market)+"</div></td>"+
      "<td class=l>"+esc(o.book)+flags+"</td><td>"+o.price.toFixed(2)+"</td><td>"+o.fairOdd.toFixed(2)+"</td><td>"+pct(o.prob)+"</td>"+
      '<td><span class="pill'+(o.suspect||stale?" warn":"")+'">+'+pct(o.ev)+"</span></td><td>"+(stake>0?eur(stake):"—")+"</td>"+
      "<td class=l><span class=s>"+esc(o.ref)+"</span></td></tr>";
  }).join("");
  $("rows").innerHTML=html||'<tr><td colspan="9" class="empty">'+(d.live&&d.live.length?"Nenhuma odd acima do EV mínimo neste momento.":"Não há jogos ao vivo nas competições seguidas neste momento.")+"</td></tr>";
  var b=rows.filter(function(o){return !o.suspect})[0];
  if(b){var st=Math.max(0,(b.price*b.prob-1)/(b.price-1))*kf*bank;$("best").className="best on";
    $("best").innerHTML='<span class="k">Melhor oportunidade agora</span><span class="v">'+esc(b.selection)+" @ "+b.price.toFixed(2)+" · "+esc(b.book)+'</span><span class="d">'+esc(b.match)+" · EV +"+pct(b.ev)+" · stake "+eur(st)+"</span>";}
  else{$("best").className="best";$("best").innerHTML='<span class="k">Melhor oportunidade agora</span><span class="v">Nada acima do limiar</span><span class="d">A lista atualiza sozinha. Podes baixar o EV mínimo para ver mais.</span>';}
  var games=(d.live||[]).filter(function(g){return !state.sport||g.sport===state.sport});
  $("nlive").textContent="("+games.length+")";
  $("games").innerHTML=games.map(function(g){return '<div class="game"><div class="lg">'+esc(g.league)+" · "+mins(g.start)+'′</div><div class="tm">'+esc(g.home)+"</div><div class=tm>"+esc(g.away)+"</div>"+(g.score?'<div class="sc">'+esc(g.score)+"</div>":"")+'<div class="s">'+g.books+" casas com odds</div></div>"}).join("")||'<div class="empty">Sem jogos ao vivo agora.</div>';
}
load();
</script>
</body>
</html>`;
