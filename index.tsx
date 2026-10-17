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
<meta name="theme-color" content="#0B1119">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Radar de Valor Live</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap">
<style>
/* Layout: app de telemóvel — barra de estado fixa em cima, lista de jogos em cartões, separadores fixos em baixo, ajustes em painel deslizante */
:root{
  --bg:#0B1119;--panel:#121A25;--panel-2:#18222F;--line:#243142;--ink:#E8EEF5;--muted:#8A99AB;
  --accent:#FF8A3D;--accent-ink:#1A0E05;
  --good:#3DD68C;--good-bg:rgba(61,214,140,.13);--warn:#F2B544;--warn-bg:rgba(242,181,68,.14);--bad:#F06A6A;--bad-bg:rgba(240,106,106,.13);
  --f-display:"Barlow Condensed","Arial Narrow",sans-serif;
  --f-body:"Barlow",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:16px/1.45 var(--f-body);min-height:100vh}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
.num{font-family:var(--f-mono);font-variant-numeric:tabular-nums}

/* barra de topo */
.top{position:sticky;top:0;z-index:20;background:rgba(11,17,25,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line);
  padding-top:env(safe-area-inset-top,0px)}
.top-in{max-width:760px;margin:0 auto;display:flex;align-items:center;gap:12px;padding-block:10px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.brand{font:700 1.45rem/1 var(--f-display);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.brand span{color:var(--accent)}
.stat{flex:1;min-width:0;font:500 .74rem/1.3 var(--f-mono);color:var(--muted);display:flex;flex-direction:column}
.stat b{color:var(--ink);font-weight:600}
.live{display:inline-flex;align-items:center;gap:6px;color:var(--good)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 rgba(61,214,140,.6);animation:pulse 2s infinite}
.live.off{color:var(--muted)}.live.off i{background:var(--muted);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(61,214,140,.55)}70%{box-shadow:0 0 0 7px rgba(61,214,140,0)}100%{box-shadow:0 0 0 0 rgba(61,214,140,0)}}
.icon-btn{width:42px;height:42px;border-radius:12px;border:1px solid var(--line);background:var(--panel);display:grid;place-items:center;flex:none}
.icon-btn svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.icon-btn.go{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.icon-btn.spin svg{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

main{max-width:760px;margin:0 auto;padding-block:16px calc(96px + env(safe-area-inset-bottom,0px));padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:14px}
.view{display:flex;flex-direction:column;gap:14px}

/* destaque */
.hero{border-radius:18px;padding:16px 18px;background:var(--panel);border:1px solid var(--line);display:flex;flex-direction:column;gap:6px;position:relative;overflow:hidden}
.hero.on{background:linear-gradient(135deg,#FF8A3D 0%,#E5602A 100%);border-color:transparent;color:var(--accent-ink)}
.hero .k{font:600 .72rem var(--f-body);text-transform:uppercase;letter-spacing:.1em;opacity:.8}
.hero .v{font:700 1.9rem/1.05 var(--f-display);text-wrap:balance}
.hero .d{font:500 .85rem var(--f-mono);opacity:.9}
.hero .row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.hero .chipx{background:rgba(26,14,5,.14);border-radius:999px;padding:3px 10px;font:600 .85rem var(--f-mono)}
.hero:not(.on) .chipx{background:var(--panel-2)}

/* filtros */
.filters{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 16px}
.filters::-webkit-scrollbar{display:none}
.chip{flex:none;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:7px 14px;font:600 1rem var(--f-display);letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chip .n{font:600 .75rem var(--f-mono);margin-left:4px;opacity:.7}

.banner{border-radius:12px;padding:11px 14px;background:var(--warn-bg);color:var(--warn);font-size:.9rem}
.banner b{color:inherit}

/* cartão de jogo */
.game{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.g-head{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line)}
.g-teams{flex:1;min-width:0}
.g-league{font:600 .7rem var(--f-body);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);display:flex;flex-wrap:wrap;gap:0 6px;align-items:baseline}
.g-league .sp{color:var(--accent)}
.g-name{font:600 1.02rem/1.25 var(--f-body);overflow-wrap:anywhere}
.g-score{font:700 1.5rem/1 var(--f-display);color:var(--ink);background:var(--panel-2);border-radius:10px;padding:6px 10px;white-space:nowrap}
.opp{display:grid;grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"main odd ev" "foot foot foot";gap:4px 12px;padding:12px 14px;border-bottom:1px solid var(--line);align-items:center}
.opp:last-child{border-bottom:0}
.o-main{grid-area:main;min-width:0}
.o-sel{font-weight:600;overflow-wrap:anywhere}
.o-mk{font-size:.82rem;color:var(--muted)}
.o-odd{grid-area:odd;text-align:right}
.o-odd b{display:block;font:600 1.25rem/1 var(--f-mono)}
.o-odd small{font:500 .72rem var(--f-mono);color:var(--muted)}
.ev{grid-area:ev;font:600 .9rem var(--f-mono);padding:5px 9px;border-radius:9px;background:var(--good-bg);color:var(--good);min-width:72px;text-align:center}
.ev.warn{background:var(--warn-bg);color:var(--warn)}
.o-foot{grid-area:foot;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.o-foot .stake{font:500 .8rem var(--f-mono);color:var(--muted);flex:1;min-width:0}
.o-foot .stake b{color:var(--ink)}
.tag{font:600 .66rem var(--f-body);text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:5px;background:var(--warn-bg);color:var(--warn)}
.bet{border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:9px;padding:6px 12px;font:600 .85rem var(--f-body)}
.bet.done{border-color:var(--line);color:var(--muted)}

.empty{background:var(--panel);border:1px dashed var(--line);border-radius:16px;padding:28px 18px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--ink);font:700 1.2rem var(--f-display);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}

/* jogos */
.glist{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.gcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
.gcard .t{font-weight:600;overflow-wrap:anywhere}
.gcard .sc{font:700 1.4rem var(--f-display);color:var(--accent)}
.gcard .m{font-size:.8rem;color:var(--muted)}

/* apostas */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
@media (max-width:520px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 12px;min-width:0}
.kpi small{display:block;font:600 .68rem var(--f-body);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.kpi b{font:600 1.15rem var(--f-mono)}
.pos{color:var(--good)}.neg{color:var(--bad)}
.bitem{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.b-top{display:flex;gap:10px;align-items:flex-start}
.b-top .l{flex:1;min-width:0}
.b-top .r{text-align:right;font:600 .95rem var(--f-mono)}
.b-acts{display:flex;gap:6px;flex-wrap:wrap}
.seg{border:1px solid var(--line);background:var(--panel-2);border-radius:8px;padding:5px 10px;font:600 .8rem var(--f-body);color:var(--muted)}
.seg.on.w{background:var(--good-bg);color:var(--good);border-color:transparent}
.seg.on.l{background:var(--bad-bg);color:var(--bad);border-color:transparent}
.seg.on.v{background:var(--panel);color:var(--ink);border-color:var(--ink)}
.seg.del{margin-left:auto}
.bar{display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:9px 14px;font:600 .9rem var(--f-body)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}

/* separadores em baixo */
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;background:rgba(18,26,37,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid var(--line);
  padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
.tabbar-in{max-width:760px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr)}
.tab{background:none;border:0;padding:9px 4px 10px;display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--muted);font:600 .72rem var(--f-body);letter-spacing:.02em;position:relative}
.tab svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tab[aria-selected="true"]{color:var(--accent)}
.tab .badge{position:absolute;top:4px;left:calc(50% + 6px);background:var(--accent);color:var(--accent-ink);border-radius:999px;font:600 .66rem var(--f-mono);padding:1px 6px}

/* painéis */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:30}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:31;background:var(--panel);border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:88vh;overflow-y:auto;
  padding-top:10px;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px));padding-left:max(18px,env(safe-area-inset-left,0px));padding-right:max(18px,env(safe-area-inset-right,0px))}
.sheet-in{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.grab{width:40px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 4px}
.sheet h2{font:700 1.4rem var(--f-display);text-transform:uppercase;letter-spacing:.04em;margin:0}
.sheet p{margin:0;color:var(--muted);font-size:.9rem}
.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.form .full{grid-column:1/-1}
label.f{display:flex;flex-direction:column;gap:5px;font:600 .72rem var(--f-body);text-transform:uppercase;letter-spacing:.07em;color:var(--muted);min-width:0}
input,select{font:500 1rem var(--f-mono);color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%;min-width:0}
.hint{font-size:.8rem;color:var(--muted);text-transform:none;letter-spacing:0;font-weight:400}

.gate{max-width:380px;margin:14vh auto 0;width:calc(100% - 32px);display:flex;flex-direction:column;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:24px}
.gate .brand{font-size:2rem}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:40;background:var(--ink);color:var(--bg);border-radius:10px;padding:9px 16px;font:600 .9rem var(--f-body)}
.about{font-size:.88rem;color:var(--muted);display:flex;flex-direction:column;gap:10px}
.about b{color:var(--ink)}
.about p{margin:0}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head>
<body>

<div class="gate" id="gate" hidden>
  <div class="brand">Radar de <span>Valor</span></div>
  <label class="f" for="code">Código de acesso<input id="code" type="password" inputmode="numeric" autocomplete="current-password"></label>
  <button class="btn primary" id="enter">Entrar</button>
  <div class="hint" id="gateMsg"></div>
</div>

<div id="app" hidden>
<header class="top"><div class="top-in">
  <div class="brand">Radar<span>.</span></div>
  <div class="stat" id="stat"><span class="live off"><i></i>A carregar</span><span>&nbsp;</span></div>
  <button class="icon-btn" id="openSettings" aria-label="Ajustes"><svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg></button>
  <button class="icon-btn go" id="refresh" aria-label="Atualizar"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg></button>
</div></header>

<main>
  <!-- OPORTUNIDADES -->
  <section class="view" id="v-opps">
    <div class="hero" id="hero"></div>
    <div class="filters" id="filters">
      <button class="chip" data-s="" aria-pressed="true">Todos</button>
      <button class="chip" data-s="futebol" aria-pressed="false">Futebol</button>
      <button class="chip" data-s="basquetebol" aria-pressed="false">Basquetebol</button>
      <button class="chip" data-s="tenis" aria-pressed="false">Ténis</button>
    </div>
    <div class="banner" id="banner" hidden></div>
    <div id="oppList" class="view"></div>
  </section>

  <!-- JOGOS -->
  <section class="view" id="v-games" hidden>
    <div class="glist" id="gameList"></div>
  </section>

  <!-- APOSTAS -->
  <section class="view" id="v-bets" hidden>
    <div class="kpis" id="kpis"></div>
    <div class="bar">
      <button class="btn" id="copyCsv">Copiar para Excel</button>
      <button class="btn" id="clearSettled">Limpar resolvidas</button>
    </div>
    <div id="betList" class="view"></div>
  </section>

  <!-- AJUDA -->
  <section class="view about" id="v-help" hidden>
    <p><b>O que é uma oportunidade.</b> Para cada jogo ao vivo, a odd justa vem da Pinnacle sem a margem dela. Se a Pinnacle não tiver esse mercado, usa-se a média sem margem de pelo menos três casas. Quando outra casa paga mais do que a odd justa, aparece aqui com o EV (lucro esperado por euro apostado).</p>
    <p><b>Stake.</b> É uma fração do critério de Kelly sobre a tua banca. Ajusta a banca e a fração em Ajustes.</p>
    <p><b>Avisos.</b> “Odd antiga” quer dizer que a casa não atualiza há mais de 60 s. “Confirmar” quer dizer EV acima de 25%, o que muitas vezes é um erro ou uma odd que já mudou. Confirma sempre a odd na casa antes de apostar.</p>
    <p><b>22bet.</b> Não está na fonte de dados. A 1xBet é do mesmo grupo e costuma ter as mesmas odds; usa-a como referência e confirma na 22bet.</p>
    <p><b>Créditos.</b> Cada atualização gasta cerca de 15 créditos da The Odds API (500 por mês no plano grátis). Com menos de 40, a app só atualiza de 15 em 15 minutos.</p>
    <p><b>Registo.</b> As apostas que registas ficam guardadas só neste telemóvel/browser. Usa “Copiar para Excel” para as passares para a tua folha.</p>
  </section>
</main>

<nav class="tabbar" role="tablist"><div class="tabbar-in">
  <button class="tab" role="tab" data-v="opps" aria-selected="true"><svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>Oportunidades<span class="badge" id="bOpps" hidden></span></button>
  <button class="tab" role="tab" data-v="games" aria-selected="false"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Ao vivo<span class="badge" id="bGames" hidden></span></button>
  <button class="tab" role="tab" data-v="bets" aria-selected="false"><svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>Apostas</button>
  <button class="tab" role="tab" data-v="help" aria-selected="false"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14"/><path d="M12 17.5h0"/></svg>Ajuda</button>
</div></nav>
</div>

<div class="scrim" id="scrim" hidden></div>
<div class="sheet" id="sSettings" hidden role="dialog" aria-labelledby="sSetT"><div class="sheet-in">
  <div class="grab"></div>
  <h2 id="sSetT">Ajustes</h2>
  <div class="form">
    <label class="f" for="bank">Banca (€)<input id="bank" type="number" value="500" min="0" step="10" inputmode="decimal"></label>
    <label class="f" for="kf">Fração Kelly (%)<input id="kf" type="number" value="25" min="0" max="100" step="5" inputmode="decimal"></label>
    <label class="f" for="minev">EV mínimo (%)<input id="minev" type="number" value="3" min="0" step="0.5" inputmode="decimal"></label>
    <label class="f" for="maxodd">Odd máxima<input id="maxodd" type="number" value="10" min="1.1" step="0.5" inputmode="decimal"></label>
    <label class="f full" for="book">Casa<select id="book"><option value="">Todas as casas</option></select></label>
    <label class="f full" for="auto">Atualizar sozinho<select id="auto"><option value="0">Não (poupa créditos)</option><option value="120">De 2 em 2 min</option><option value="300">De 5 em 5 min</option><option value="600">De 10 em 10 min</option></select>
      <span class="hint">Cada atualização gasta cerca de 15 créditos.</span></label>
  </div>
  <button class="btn primary" data-close>Feito</button>
</div></div>

<div class="sheet" id="sBet" hidden role="dialog" aria-labelledby="sBetT"><div class="sheet-in">
  <div class="grab"></div>
  <h2 id="sBetT">Registar aposta</h2>
  <p id="betDesc"></p>
  <div class="form">
    <label class="f" for="betOdd">Odd que apanhaste<input id="betOdd" type="number" step="0.01" min="1.01" inputmode="decimal"></label>
    <label class="f" for="betStake">Stake (€)<input id="betStake" type="number" step="0.5" min="0" inputmode="decimal"></label>
    <label class="f full" for="betBook">Casa onde apostaste<input id="betBook" value="22bet"></label>
  </div>
  <div class="bar"><button class="btn primary" id="betSave">Guardar</button><button class="btn" data-close>Cancelar</button></div>
</div></div>

<div class="toast" id="toast" hidden></div>

<script>
var $=function(id){return document.getElementById(id)};
var S={data:null,sport:"",view:"opps",timer:null,left:0,rows:[],pending:null,loading:false};
var SPORT={futebol:"Futebol",basquetebol:"Basquetebol",tenis:"Ténis"};
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}
function num(id){var v=parseFloat(String($(id).value).replace(",","."));return isNaN(v)?0:v}
function eur(v){return (v<0?"−":"")+Math.abs(v).toFixed(2).replace(".",",")+" €"}
function pct(v){return (v*100).toFixed(1).replace(".",",")+"%"}
function odd(v){return v.toFixed(2).replace(".",",")}
function mins(start){var m=Math.max(0,Math.round((Date.now()-Date.parse(start))/60000));return m<60?m+" min":Math.floor(m/60)+"h"+String(m%60).padStart(2,"0")}
function toast(t){var el=$("toast");el.textContent=t;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){el.hidden=true},1800)}

/* ajustes */
["bank","kf","minev","maxodd","auto"].forEach(function(k){var v=ls("radar-"+k);if(v!==null&&v!==undefined)$(k).value=v;$(k).addEventListener("input",function(){ls("radar-"+k,$(k).value);render()})});
$("book").addEventListener("change",function(){ls("radar-book",$("book").value);render()});
$("auto").addEventListener("change",schedule);

/* painéis */
function openSheet(id){$("scrim").hidden=false;$(id).hidden=false}
function closeSheets(){$("scrim").hidden=true;$("sSettings").hidden=true;$("sBet").hidden=true}
$("openSettings").addEventListener("click",function(){openSheet("sSettings")});
$("scrim").addEventListener("click",closeSheets);
document.querySelectorAll("[data-close]").forEach(function(b){b.addEventListener("click",closeSheets)});
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSheets()});

/* navegação */
document.querySelectorAll(".tab").forEach(function(t){t.addEventListener("click",function(){
  S.view=t.dataset.v;document.querySelectorAll(".tab").forEach(function(x){x.setAttribute("aria-selected",x===t?"true":"false")});
  ["opps","games","bets","help"].forEach(function(v){$("v-"+v).hidden=v!==S.view});window.scrollTo(0,0);render();
})});
document.querySelectorAll("#filters .chip").forEach(function(b){b.addEventListener("click",function(){S.sport=b.dataset.s;document.querySelectorAll("#filters .chip").forEach(function(x){x.setAttribute("aria-pressed",x===b?"true":"false")});render()})});

/* dados */
$("refresh").addEventListener("click",function(){load()});
$("enter").addEventListener("click",function(){ls("radar-code",$("code").value);load()});
$("code").addEventListener("keydown",function(e){if(e.key==="Enter")$("enter").click()});
function load(){
  if(S.loading)return;S.loading=true;$("refresh").classList.add("spin");
  var demo=location.search.indexOf("demo=1")>=0;
  fetch("/api/data"+(demo?"?demo=1":""),{headers:{"x-code":ls("radar-code")||""}}).then(function(r){
    if(r.status===401){$("app").hidden=true;$("gate").hidden=false;$("gateMsg").textContent=ls("radar-code")?"Código errado. Tenta outra vez.":"";throw null}
    return r.json().then(function(d){if(!r.ok)throw new Error(d.error||("Erro "+r.status));return d});
  }).then(function(d){$("gate").hidden=true;$("app").hidden=false;S.data=d;fillBooks();render();schedule()})
  .catch(function(e){if(e){$("app").hidden=false;$("gate").hidden=true;S.err=e.message;render();schedule()}})
  .finally(function(){S.loading=false;$("refresh").classList.remove("spin")});
}
function schedule(){
  clearInterval(S.timer);var s=parseInt($("auto").value,10);ls("radar-auto",$("auto").value);if(!s){statLine();return}S.left=s;
  S.timer=setInterval(function(){if(document.hidden)return;S.left--;if(S.left<=0){clearInterval(S.timer);load()}else statLine()},1000);
}
function fillBooks(){
  var sel=$("book"),cur=ls("radar-book");if(cur===null||cur===undefined)cur="onexbet";
  sel.innerHTML='<option value="">Todas as casas</option>';
  (S.data.books||[]).filter(function(b){return b.key!=="pinnacle"}).forEach(function(b){var o=document.createElement("option");o.value=b.key;o.textContent=b.key==="onexbet"?"1xBet (≈ 22bet)":b.title;sel.appendChild(o)});
  sel.value=cur;if(sel.value!==cur)sel.value="";
}
function statLine(){
  var d=S.data;if(!d){return}
  var t=new Date(d.updatedAt).toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"});
  var l1=d.mode==="live"?'<span class="live"><i></i>Ao vivo · '+t+"</span>":'<span class="live off"><i></i>Exemplo · '+t+"</span>";
  var bits=[];
  if(d.quota&&d.quota.remaining!=null)bits.push("<b>"+d.quota.remaining+"</b> créditos");
  var s=parseInt($("auto").value,10);if(s&&S.left>0)bits.push("próx. "+S.left+"s");
  $("stat").innerHTML=l1+"<span>"+(bits.join(" · ")||"&nbsp;")+"</span>";
}

/* cálculo */
function settings(){return{bank:num("bank"),thr:num("minev")/100,kf:Math.min(1,Math.max(0,num("kf")/100)),max:num("maxodd")||99,book:$("book").value}}
function stakeFor(o,s){var k=(o.price*o.prob-1)/(o.price-1);return Math.max(0,k)*s.kf*s.bank}
function filtered(){
  var d=S.data,s=settings();if(!d)return[];
  return (d.opps||[]).filter(function(o){return o.ev>=s.thr&&o.price<=s.max&&(!S.sport||o.sport===S.sport)&&(!s.book||o.bookKey===s.book)});
}

function render(){
  statLine();var d=S.data;if(!d&&!S.err)return;
  var s=settings();var rows=filtered();S.rows=rows;
  /* contadores */
  var counts={"":0,futebol:0,basquetebol:0,tenis:0};
  ((d&&d.opps)||[]).forEach(function(o){if(o.ev>=s.thr&&o.price<=s.max&&(!s.book||o.bookKey===s.book)){counts[""]++;counts[o.sport]++}});
  document.querySelectorAll("#filters .chip").forEach(function(b){var n=counts[b.dataset.s]||0;b.innerHTML=(b.dataset.s?SPORT[b.dataset.s]:"Todos")+'<span class="n">'+n+"</span>"});
  $("bOpps").hidden=!counts[""];$("bOpps").textContent=counts[""];
  var nl=d&&d.live?d.live.length:0;$("bGames").hidden=!nl;$("bGames").textContent=nl;

  /* aviso */
  var ban="";
  if(S.err){ban="Não foi possível atualizar: "+esc(S.err)+". Tenta outra vez daqui a pouco.";S.err=null}
  else if(d.mode==="nokey")ban="<b>Modo exemplo.</b> Falta a chave da The Odds API no servidor; os jogos abaixo são inventados.";
  else if(d.mode==="demo")ban="<b>Modo exemplo</b> (abriste com ?demo=1).";
  else if(d.lowQuota)ban="<b>Poucos créditos.</b> Para os poupar, os dados só atualizam de 15 em 15 minutos.";
  else if(d.errors&&d.errors.length)ban="Algumas competições falharam: "+esc(d.errors.join(" · "));
  $("banner").innerHTML=ban;$("banner").hidden=!ban;
  if(!d)return;

  /* destaque */
  var best=rows.filter(function(o){return !o.suspect&&o.ageSec<=60})[0]||rows.filter(function(o){return !o.suspect})[0];
  if(best){
    $("hero").className="hero on";
    $("hero").innerHTML='<span class="k">Melhor oportunidade agora</span><span class="v">'+esc(best.selection)+" @ "+odd(best.price)+'</span><span class="d">'+esc(best.match)+" · "+esc(best.book)+'</span><div class="row"><span class="chipx">EV +'+pct(best.ev)+'</span><span class="chipx">Stake '+eur(stakeFor(best,s))+'</span><span class="chipx">Justa '+odd(best.fairOdd)+"</span></div>";
  }else{
    $("hero").className="hero";
    $("hero").innerHTML='<span class="k">Melhor oportunidade agora</span><span class="v">Nada acima de '+pct(s.thr)+'</span><span class="d">'+(nl?nl+" jogos ao vivo a ser vigiados.":"Sem jogos ao vivo nas competições seguidas.")+" Carrega em atualizar daqui a pouco.</span>";
  }

  /* lista agrupada por jogo */
  var groups=[],byId={};
  rows.forEach(function(o,i){o._i=i;if(!byId[o.eventId]){byId[o.eventId]={o:o,items:[]};groups.push(byId[o.eventId])}byId[o.eventId].items.push(o)});
  var logged=bets().map(function(b){return b.key});
  $("oppList").innerHTML=groups.length?groups.map(function(g){
    var h=g.o;
    return '<article class="game"><div class="g-head"><div class="g-teams"><div class="g-league"><span class="sp">'+SPORT[h.sport]+"</span>"+esc(h.league)+" · há "+mins(h.start)+'</div><div class="g-name">'+esc(h.match)+"</div></div>"+(h.score?'<div class="g-score">'+esc(h.score)+"</div>":"")+"</div>"+
      g.items.map(function(o){
        var stale=o.ageSec>60||o.lagSec>45,warn=stale||o.suspect,st=stakeFor(o,s),key=o.eventId+"|"+o.selection+"|"+o.market,done=logged.indexOf(key)>=0;
        return '<div class="opp"><div class="o-main"><div class="o-sel">'+esc(o.selection)+'</div><div class="o-mk">'+esc(o.market)+" · "+esc(o.book)+"</div></div>"+
          '<div class="o-odd"><b>'+odd(o.price)+"</b><small>justa "+odd(o.fairOdd)+"</small></div>"+
          '<div class="ev'+(warn?" warn":"")+'">+'+pct(o.ev)+"</div>"+
          '<div class="o-foot"><span class="stake">Stake <b>'+eur(st)+"</b> · prob. "+pct(o.prob)+" · "+esc(o.ref)+"</span>"+
          (o.suspect?'<span class="tag">Confirmar</span>':"")+(stale?'<span class="tag">Odd antiga</span>':"")+
          '<button class="bet'+(done?" done":"")+'" data-i="'+o._i+'">'+(done?"Registada":"Apostei")+"</button></div></div>";
      }).join("")+"</article>";
  }).join(""):'<div class="empty"><b>'+(nl?"Sem valor neste momento":"Sem jogos ao vivo")+"</b>"+(nl?"Nenhuma odd passa o EV mínimo com os filtros atuais. Baixa o EV mínimo ou escolhe todas as casas em Ajustes.":"Quando começarem jogos nas competições seguidas, aparecem aqui.")+"</div>";
  document.querySelectorAll(".bet").forEach(function(b){b.addEventListener("click",function(){openBet(S.rows[+b.dataset.i])})});

  /* jogos */
  var games=(d.live||[]);
  $("gameList").innerHTML=games.length?games.map(function(g){
    var n=(d.opps||[]).filter(function(o){return o.eventId===g.id&&o.ev>=s.thr&&o.price<=s.max}).length;
    return '<div class="gcard"><div class="g-league"><span class="sp">'+SPORT[g.sport]+"</span>"+esc(g.league)+'</div><div class="t">'+esc(g.home)+'</div><div class="t">'+esc(g.away)+"</div>"+(g.score?'<div class="sc">'+esc(g.score)+"</div>":"")+'<div class="m">há '+mins(g.start)+" · "+g.books+" casas · "+(n?"<b class=pos>"+n+" com valor</b>":"sem valor")+"</div></div>";
  }).join(""):'<div class="empty"><b>Sem jogos ao vivo</b>Futebol (principais ligas), NBA, Euroliga e ténis ATP/WTA.</div>';

  renderBets();
}

/* registo de apostas */
function bets(){try{return JSON.parse(ls("radar-bets")||"[]")}catch(e){return[]}}
function saveBets(b){ls("radar-bets",JSON.stringify(b))}
function openBet(o){
  S.pending=o;$("betDesc").textContent=o.match+" · "+o.selection+" ("+o.market+")";
  $("betOdd").value=o.price.toFixed(2);$("betStake").value=stakeFor(o,settings()).toFixed(2);openSheet("sBet");
}
$("betSave").addEventListener("click",function(){
  var o=S.pending;if(!o)return;var b=bets();
  b.unshift({id:Date.now(),t:new Date().toISOString(),key:o.eventId+"|"+o.selection+"|"+o.market,match:o.match,league:o.league,sel:o.selection,market:o.market,book:$("betBook").value||o.book,odd:num("betOdd"),stake:num("betStake"),fair:o.fairOdd,ev:o.ev,status:"pend"});
  saveBets(b);closeSheets();toast("Aposta registada");render();
});
function profit(b){return b.status==="w"?b.stake*(b.odd-1):b.status==="l"?-b.stake:0}
function renderBets(){
  var b=bets(),settled=b.filter(function(x){return x.status==="w"||x.status==="l"});
  var staked=settled.reduce(function(a,x){return a+x.stake},0),pl=b.reduce(function(a,x){return a+profit(x)},0);
  var pend=b.filter(function(x){return x.status==="pend"});
  var wins=settled.filter(function(x){return x.status==="w"}).length;
  $("kpis").innerHTML='<div class="kpi"><small>Apostas</small><b>'+b.length+'</b></div><div class="kpi"><small>Lucro</small><b class="'+(pl>=0?"pos":"neg")+'">'+eur(pl)+'</b></div><div class="kpi"><small>ROI</small><b class="'+(pl>=0?"pos":"neg")+'">'+(staked?pct(pl/staked):"—")+'</b></div><div class="kpi"><small>Acerto</small><b>'+(settled.length?pct(wins/settled.length):"—")+"</b></div>";
  $("betList").innerHTML=b.length?b.map(function(x){
    var dt=new Date(x.t).toLocaleString("pt-PT",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
    var p=profit(x);
    return '<div class="bitem"><div class="b-top"><div class="l"><div class="o-sel">'+esc(x.sel)+'</div><div class="o-mk">'+esc(x.match)+" · "+esc(x.market)+"</div><div class=o-mk>"+dt+" · "+esc(x.book)+" · EV +"+pct(x.ev)+'</div></div><div class="r">'+odd(x.odd)+"<br><span class=o-mk>"+eur(x.stake)+"</span>"+(x.status!=="pend"?'<br><span class="'+(p>=0?"pos":"neg")+'">'+(p>0?"+":"")+eur(p)+"</span>":"")+"</div></div>"+
      '<div class="b-acts"><button class="seg w'+(x.status==="w"?" on":"")+'" data-id="'+x.id+'" data-st="w">Ganhou</button><button class="seg l'+(x.status==="l"?" on":"")+'" data-id="'+x.id+'" data-st="l">Perdeu</button><button class="seg v'+(x.status==="v"?" on":"")+'" data-id="'+x.id+'" data-st="v">Anulada</button><button class="seg del" data-id="'+x.id+'" data-st="x" aria-label="Apagar">Apagar</button></div></div>';
  }).join(""):'<div class="empty"><b>Ainda sem apostas</b>Carrega em “Apostei” numa oportunidade para a registar aqui e acompanhar o lucro e o ROI.</div>';
  document.querySelectorAll(".seg").forEach(function(btn){btn.addEventListener("click",function(){
    var id=+btn.dataset.id,st=btn.dataset.st,all=bets();
    if(st==="x"){if(btn.dataset.armed){all=all.filter(function(x){return x.id!==id});saveBets(all);render()}else{btn.dataset.armed="1";btn.textContent="Confirmar?"}return}
    all.forEach(function(x){if(x.id===id)x.status=x.status===st?"pend":st});saveBets(all);render();
  })});
  $("bOpps").title=pend.length+" pendentes";
}
$("clearSettled").addEventListener("click",function(){
  var btn=$("clearSettled");if(!btn.dataset.armed){btn.dataset.armed="1";btn.textContent="Tens a certeza?";setTimeout(function(){btn.dataset.armed="";btn.textContent="Limpar resolvidas"},3000);return}
  saveBets(bets().filter(function(x){return x.status==="pend"}));btn.dataset.armed="";btn.textContent="Limpar resolvidas";render();
});
$("copyCsv").addEventListener("click",function(){
  var lines=["Data\tJogo\tCompetição\tMercado\tSeleção\tCasa\tOdd\tStake\tOdd justa\tEV\tEstado\tLucro"];
  bets().forEach(function(x){lines.push([new Date(x.t).toLocaleString("pt-PT"),x.match,x.league,x.market,x.sel,x.book,String(x.odd).replace(".",","),String(x.stake).replace(".",","),x.fair.toFixed(2).replace(".",","),(x.ev*100).toFixed(1).replace(".",",")+"%",{pend:"Pendente",w:"Ganhou",l:"Perdeu",v:"Anulada"}[x.status],profit(x).toFixed(2).replace(".",",")].join("\t"))});
  var txt=lines.join("\n");
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).then(function(){toast("Copiado — cola no Excel")},function(){toast("Não deu para copiar")});
  else toast("Não deu para copiar");
});

load();
</script>
</body>
</html>
`;
