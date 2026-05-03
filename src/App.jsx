import { useState, useEffect, useRef } from "react";

const API = "https://api.binance.com/api/v3";

function ema(arr, n) {
  if (arr.length < n) return null;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function rsi(arr, n = 14) {
  if (arr.length < n + 1) return 50;
  const ch = arr.slice(1).map((p, i) => p - arr[i]);
  const ag = ch.slice(0, n).filter(x => x > 0).reduce((a, b) => a + b, 0) / n;
  const al = ch.slice(0, n).filter(x => x < 0).map(Math.abs).reduce((a, b) => a + b, 0) / n;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function bb(arr, n = 20) {
  if (arr.length < n) return null;
  const sl = arr.slice(-n);
  const m = sl.reduce((a, b) => a + b) / n;
  const s = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { upper: m + 2 * s, middle: m, lower: m - 2 * s };
}

function analyze(closes) {
  if (closes.length < 50) return { signal: "WAIT", conf: 0, rsi: 50, bb: null, ema20: null };
  const r = rsi(closes);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const b = bb(closes);
  const p = closes[closes.length - 1];
  let score = 0;
  if (e20 && e50) score += e20 > e50 && p > e20 ? 1 : e20 < e50 && p < e20 ? -1 : 0;
  score += r < 35 ? 1 : r > 65 ? -1 : 0;
  if (b) score += p < b.lower ? 1 : p > b.upper ? -1 : 0;
  const atr = Math.abs(closes[closes.length - 1] - closes[closes.length - 5]) || p * 0.01;
  const signal = score >= 2 ? "BUY" : score <= -2 ? "SELL" : "HOLD";
  const conf = signal !== "HOLD" ? Math.min(92, 55 + Math.abs(score) * 15) : 35;
  const sl = signal === "BUY" ? p - atr * 2 : p + atr * 2;
  const tp = signal === "BUY" ? p + atr * 3 : p - atr * 3;
  return { signal, conf, rsi: r, bb: b, ema20: e20, sl, tp };
}

async function getTopMovers() {
  try {
    const r = await fetch(`${API}/ticker/24hr`);
    const d = await r.json();
    return d.filter(t => t.symbol.endsWith("USDT") && !/(DOWN|UP|BULL|BEAR)/.test(t.symbol))
      .sort((a, b) => Math.abs(+b.priceChangePercent) - Math.abs(+a.priceChangePercent))
      .slice(0, 2).map(t => ({ symbol: t.symbol, label: t.symbol.replace("USDT", "/USDT"), price: +t.lastPrice, pct: +t.priceChangePercent }));
  } catch { return [{ symbol: "BTCUSDT", label: "BTC/USDT", price: 67000, pct: 0 }, { symbol: "ETHUSDT", label: "ETH/USDT", price: 3500, pct: 0 }]; }
}

async function searchCoins(q) {
  try {
    const r = await fetch(`${API}/ticker/24hr`);
    const d = await r.json();
    return d.filter(t => t.symbol.endsWith("USDT") && t.symbol.includes(q.toUpperCase()) && !/(DOWN|UP|BULL|BEAR)/.test(t.symbol))
      .slice(0, 5).map(t => ({ symbol: t.symbol, label: t.symbol.replace("USDT", "/USDT"), price: +t.lastPrice, pct: +t.priceChangePercent }));
  } catch { return []; }
}

async function getKlines(symbol) {
  try {
    const r = await fetch(`${API}/klines?symbol=${symbol}&interval=5m&limit=100`);
    const d = await r.json();
    return d.map(k => +k[4]);
  } catch { return []; }
}

async function getTicker(symbol) {
  try {
    const r = await fetch(`${API}/ticker/24hr?symbol=${symbol}`);
    const d = await r.json();
    return { price: +d.lastPrice, pct: +d.priceChangePercent };
  } catch { return null; }
}

export default function App() {
  const [pairs, setPairs] = useState([]);
  const [active, setActive] = useState(null);
  const [analyses, setAnalyses] = useState({});
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState("SAFE");
  const [logs, setLogs] = useState([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const timer = useRef(null);
  const searchTimer = useRef(null);

  const log = (type, msg) => {
    const t = new Date();
    const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
    setLogs(prev => [{ type, msg, time, id: Math.random() }, ...prev].slice(0, 50));
  };

  useEffect(() => {
    (async () => {
      log("SYS", "Loading top movers from Binance...");
      const movers = await getTopMovers();
      const enriched = await Promise.all(movers.map(async m => {
        const closes = await getKlines(m.symbol);
        return { ...m, closes, auto: true };
      }));
      setPairs(enriched);
      setActive(enriched[0]?.symbol);
      const a = {};
      enriched.forEach(p => { a[p.symbol] = analyze(p.closes); });
      setAnalyses(a);
      log("INFO", `Loaded: ${enriched.map(p => p.label).join(", ")}`);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      const r = await searchCoins(query);
      setResults(r);
    }, 600);
  }, [query]);

  const addPair = async (pair) => {
    if (pairs.length >= 4) return log("WARN", "Max 4 pairs!");
    if (pairs.find(p => p.symbol === pair.symbol)) return log("WARN", "Already added!");
    const closes = await getKlines(pair.symbol);
    const p = { ...pair, closes, auto: false };
    setPairs(prev => [...prev, p]);
    setAnalyses(prev => ({ ...prev, [pair.symbol]: analyze(closes) }));
    setActive(pair.symbol);
    setShowSearch(false);
    setQuery("");
    setResults([]);
    log("INFO", `Added ${pair.label}`);
  };

  const removePair = (symbol) => {
    setPairs(prev => prev.filter(p => p.symbol !== symbol));
    if (active === symbol) setActive(pairs.find(p => p.symbol !== symbol)?.symbol);
    log("INFO", `Removed ${symbol}`);
  };

  const refresh = async () => {
    const updated = await Promise.all(pairs.map(async p => {
      const ticker = await getTicker(p.symbol);
      const closes = await getKlines(p.symbol);
      if (!ticker) return p;
      const a = analyze(closes);
      setAnalyses(prev => ({ ...prev, [p.symbol]: a }));
      const minConf = mode === "SAFE" ? 70 : 58;
      if (a.conf >= minConf && a.signal !== "HOLD" && a.signal !== "WAIT") {
        log(a.signal, `${p.label} @ $${ticker.price.toFixed(2)} | ${a.conf.toFixed(0)}% | SL:$${(a.sl||0).toFixed(2)} TP:$${(a.tp||0).toFixed(2)}`);
      }
      return { ...p, price: ticker.price, pct: ticker.pct, closes };
    }));
    setPairs(updated);
    setTick(t => t + 1);
  };

  useEffect(() => {
    if (running) {
      log("SYS", `Bot STARTED — ${mode} mode`);
      refresh();
      timer.current = setInterval(refresh, 30000);
    } else {
      clearInterval(timer.current);
      if (tick > 0) log("SYS", "Bot PAUSED");
    }
    return () => clearInterval(timer.current);
  }, [running, mode]);

  const activePair = pairs.find(p => p.symbol === active);
  const activeA = active ? analyses[active] : null;
  const fmt = (n) => n < 1 ? n?.toFixed(5) : n < 100 ? n?.toFixed(3) : n?.toFixed(2);
  const sigColor = { BUY: "#00e87a", SELL: "#ff3d5a", HOLD: "#f5c518", WAIT: "#888" };

  return (
    <div style={{ minHeight: "100vh", background: "#070a0f", color: "#dde", fontFamily: "monospace", padding: 0 }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#1e2330}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
        .btn{cursor:pointer;transition:all .15s}.btn:hover{filter:brightness(1.2)}
        input{outline:none;font-family:monospace}
      `}</style>

      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #1a1f2e", background: "#07090e", position: "sticky", top: 0, zIndex: 99 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: 1, color: "#00e87a" }}>⚡ NEXUS TRADER</div>
          <div style={{ fontSize: 9, color: "#444", letterSpacing: 2 }}>BINANCE LIVE SIGNALS</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn" onClick={() => setMode(m => m === "SAFE" ? "AGGR" : "SAFE")} style={{ padding: "5px 10px", borderRadius: 5, border: `1px solid ${mode === "SAFE" ? "#00e87a55" : "#ff3d5a55"}`, background: mode === "SAFE" ? "#00e87a15" : "#ff3d5a15", color: mode === "SAFE" ? "#00e87a" : "#ff3d5a", fontSize: 10, fontWeight: 700 }}>
            {mode === "SAFE" ? "🛡 SAFE" : "⚡ AGGR"}
          </button>
          <button className="btn" onClick={() => setRunning(r => !r)} style={{ padding: "5px 12px", borderRadius: 5, border: `1px solid ${running ? "#ff3d5a55" : "#00e87a55"}`, background: running ? "#ff3d5a15" : "#00e87a15", color: running ? "#ff3d5a" : "#00e87a", fontSize: 11, fontWeight: 700 }}>
            <span style={{ animation: running ? "pulse 1s infinite" : "none", display: "inline-block" }}>{running ? "■" : "▶"}</span> {running ? "STOP" : "START"}
          </button>
        </div>
      </div>

      <div style={{ padding: 14, display: "grid", gap: 12 }}>

        {/* PAIRS */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 10, color: "#444" }}>
            <span>PAIRS ({pairs.length}/4) · <span style={{ color: "#f5c518" }}>AUTO</span> = top movers</span>
            {pairs.length < 4 && (
              <button className="btn" onClick={() => setShowSearch(s => !s)} style={{ background: "none", border: "1px solid #00aaff55", color: "#00aaff", padding: "2px 8px", borderRadius: 4, fontSize: 10, cursor: "pointer" }}>
                {showSearch ? "✕ CANCEL" : "+ ADD"}
              </button>
            )}
          </div>

          {showSearch && (
            <div style={{ marginBottom: 10, animation: "fadein .2s" }}>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search e.g. SOL, DOGE, ADA..." style={{ width: "100%", padding: "9px 12px", background: "#0d1018", border: "1px solid #00aaff44", borderRadius: 7, color: "#ddd", fontSize: 12 }} autoFocus />
              {results.map(r => (
                <div key={r.symbol} onClick={() => addPair(r)} className="btn" style={{ padding: "8px 12px", background: "#0d1018", borderBottom: "1px solid #1a1f2e", display: "flex", justifyContent: "space-between", fontSize: 12, cursor: "pointer" }}>
                  <span style={{ fontWeight: 700, color: "#ccc" }}>{r.label}</span>
                  <span style={{ color: r.pct >= 0 ? "#00e87a" : "#ff3d5a" }}>{r.pct >= 0 ? "▲" : "▼"}{Math.abs(r.pct).toFixed(2)}%</span>
                </div>
              ))}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: "center", padding: 24, color: "#444" }}>Loading Binance data...</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {pairs.map(p => {
                const a = analyses[p.symbol];
                const sc = sigColor[a?.signal] || "#888";
                const isAct = active === p.symbol;
                return (
                  <div key={p.symbol} onClick={() => setActive(p.symbol)} className="btn" style={{ padding: 12, borderRadius: 9, border: `1px solid ${isAct ? "#00e87a44" : "#1a1f2e"}`, background: isAct ? "#00e87a08" : "#0d1018", position: "relative", cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isAct ? "#00e87a" : "#aaa" }}>{p.label}</span>
                      {p.auto && <span style={{ fontSize: 8, background: "#f5c51820", color: "#f5c518", padding: "1px 4px", borderRadius: 3 }}>AUTO</span>}
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: "#fff" }}>${fmt(p.price)}</div>
                    <div style={{ fontSize: 10, color: p.pct >= 0 ? "#00e87a" : "#ff3d5a", marginTop: 2 }}>{p.pct >= 0 ? "▲" : "▼"}{Math.abs(p.pct).toFixed(2)}%</div>
                    {a && <div style={{ marginTop: 6, fontSize: 10, fontWeight: 700, color: sc }}>● {a.signal} {a.conf > 0 ? `${a.conf.toFixed(0)}%` : ""}</div>}
                    {!p.auto && (
                      <button onClick={e => { e.stopPropagation(); removePair(p.symbol); }} style={{ position: "absolute", top: 6, right: 6, background: "#ff3d5a22", border: "1px solid #ff3d5a44", color: "#ff3d5a", borderRadius: 3, width: 16, height: 16, fontSize: 9, cursor: "pointer" }}>✕</button>
                    )}
                  </div>
                );
              })}
              {pairs.length < 4 && !showSearch && (
                <div onClick={() => setShowSearch(true)} className="btn" style={{ padding: 12, borderRadius: 9, border: "1px dashed #1a1f2e", background: "#0a0c10", display: "flex", alignItems: "center", justifyContent: "center", color: "#2a3040", fontSize: 12, cursor: "pointer", minHeight: 80 }}>+ Add pair</div>
              )}
            </div>
          )}
        </div>

        {/* ACTIVE PAIR DETAIL */}
        {activePair && activeA && (
          <>
            {/* Signal Box */}
            <div style={{ padding: 14, background: "#0d1018", borderRadius: 10, border: `1px solid ${sigColor[activeA.signal]}33` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 11, color: "#555", marginBottom: 2 }}>{activePair.label} · 5m chart</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: "#fff" }}>${fmt(activePair.price)}</div>
                  <div style={{ fontSize: 11, color: activePair.pct >= 0 ? "#00e87a" : "#ff3d5a", marginTop: 2 }}>{activePair.pct >= 0 ? "▲" : "▼"}{Math.abs(activePair.pct).toFixed(2)}% 24h</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: sigColor[activeA.signal] }}>{activeA.signal}</div>
                  <div style={{ fontSize: 11, color: "#666" }}>{activeA.conf.toFixed(0)}% confidence</div>
                </div>
              </div>

              {/* Confidence Bar */}
              <div style={{ marginTop: 12, height: 5, background: "#1a1f2e", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${activeA.conf}%`, background: sigColor[activeA.signal], borderRadius: 3, transition: "width .8s" }} />
              </div>

              {/* Trade Levels */}
              {activeA.signal !== "HOLD" && activeA.signal !== "WAIT" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
                  {[["📍 Entry", activePair.price, "#f5c518"], ["🛑 Stop Loss", activeA.sl, "#ff3d5a"], ["🎯 Take Profit", activeA.tp, "#00e87a"]].map(([label, val, color]) => (
                    <div key={label} style={{ padding: "8px 10px", background: "#070a0f", borderRadius: 7, border: `1px solid ${color}22` }}>
                      <div style={{ fontSize: 9, color: "#555", marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color }}>${fmt(val)}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Advice */}
              <div style={{ marginTop: 10, padding: "8px 10px", background: "#070a0f", borderRadius: 7, fontSize: 10, color: "#888", lineHeight: 1.6 }}>
                {activeA.signal === "BUY" && `✅ Buy signal! Enter around $${fmt(activePair.price)}. Set stop loss at $${fmt(activeA.sl)} on Binance. Target $${fmt(activeA.tp)}.`}
                {activeA.signal === "SELL" && `🔴 Sell/avoid signal. Price may drop. If holding, consider exit.`}
                {(activeA.signal === "HOLD" || activeA.signal === "WAIT") && `⏳ No clear signal yet. Wait for stronger confirmation.`}
              </div>
            </div>

            {/* Indicators */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {/* RSI */}
              <div style={{ padding: 10, background: "#0d1018", borderRadius: 9, border: "1px solid #1a1f2e" }}>
                <div style={{ fontSize: 9, color: "#555", marginBottom: 5 }}>RSI (14)</div>
                <div style={{ height: 3, background: "#1a1f2e", borderRadius: 2, overflow: "hidden", marginBottom: 5 }}>
                  <div style={{ height: "100%", width: `${activeA.rsi}%`, background: activeA.rsi > 70 ? "#ff3d5a" : activeA.rsi < 30 ? "#00e87a" : "#00aaff", transition: "width .5s" }} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: activeA.rsi > 70 ? "#ff3d5a" : activeA.rsi < 30 ? "#00e87a" : "#fff" }}>{activeA.rsi.toFixed(0)}</div>
                <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>{activeA.rsi > 70 ? "OVERBOUGHT" : activeA.rsi < 30 ? "OVERSOLD" : "NEUTRAL"}</div>
              </div>
              {/* EMA */}
              <div style={{ padding: 10, background: "#0d1018", borderRadius: 9, border: "1px solid #1a1f2e" }}>
                <div style={{ fontSize: 9, color: "#555", marginBottom: 5 }}>EMA TREND</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: activePair.price > (activeA.ema20 || 0) ? "#00e87a" : "#ff3d5a" }}>{activePair.price > (activeA.ema20 || 0) ? "BULLISH ▲" : "BEARISH ▼"}</div>
                <div style={{ fontSize: 9, color: "#555", marginTop: 4 }}>EMA20: ${fmt(activeA.ema20)}</div>
              </div>
              {/* BB */}
              <div style={{ padding: 10, background: "#0d1018", borderRadius: 9, border: "1px solid #1a1f2e" }}>
                <div style={{ fontSize: 9, color: "#555", marginBottom: 5 }}>BOLLINGER</div>
                {activeA.bb ? (
                  <>
                    <div style={{ height: 3, background: "#1a1f2e", borderRadius: 2, overflow: "hidden", marginBottom: 5 }}>
                      <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, ((activePair.price - activeA.bb.lower) / (activeA.bb.upper - activeA.bb.lower)) * 100))}%`, background: activePair.price > activeA.bb.upper ? "#ff3d5a" : activePair.price < activeA.bb.lower ? "#00e87a" : "#f5c518", transition: "width .5s" }} />
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: activePair.price > activeA.bb.upper ? "#ff3d5a" : activePair.price < activeA.bb.lower ? "#00e87a" : "#f5c518" }}>{activePair.price > activeA.bb.upper ? "OVERBOUGHT" : activePair.price < activeA.bb.lower ? "OVERSOLD" : "IN RANGE"}</div>
                  </>
                ) : <div style={{ color: "#333", fontSize: 10 }}>Loading...</div>}
              </div>
            </div>
          </>
        )}

        {/* BOT STATUS + LOG */}
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8 }}>
          <div style={{ padding: 12, background: "#0d1018", borderRadius: 9, border: `1px solid ${running ? "#00e87a33" : "#1a1f2e"}`, minWidth: 100 }}>
            <div style={{ fontSize: 9, color: "#444", marginBottom: 6 }}>STATUS</div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: running ? "#00e87a" : "#333", animation: running ? "pulse 1.2s infinite" : "none", boxShadow: running ? "0 0 8px #00e87a" : "none" }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: running ? "#00e87a" : "#444" }}>{running ? "LIVE" : "OFF"}</span>
            </div>
            <div style={{ fontSize: 9, color: "#444", marginTop: 6, lineHeight: 1.7 }}>
              <div>{mode} mode</div>
              <div>Tick #{tick}</div>
              <div>30s refresh</div>
            </div>
          </div>
          <div style={{ padding: 12, background: "#0d1018", borderRadius: 9, border: "1px solid #1a1f2e", overflow: "hidden" }}>
            <div style={{ fontSize: 9, color: "#444", marginBottom: 6 }}>ACTIVITY LOG</div>
            <div style={{ height: 100, overflowY: "auto" }}>
              {logs.length === 0 ? <div style={{ color: "#222", fontSize: 10 }}>Press START...</div> : logs.map(l => {
                const c = { SYS: "#555", INFO: "#4488ff", BUY: "#00e87a", SELL: "#ff3d5a", WARN: "#f5c518" }[l.type] || "#888";
                return (
                  <div key={l.id} style={{ display: "flex", gap: 5, padding: "3px 0", borderBottom: "1px solid #0f1218", fontSize: 9, animation: "fadein .2s" }}>
                    <span style={{ color: "#333", flexShrink: 0 }}>{l.time}</span>
                    <span style={{ color: c, fontWeight: 700, flexShrink: 0, width: 32 }}>{l.type}</span>
                    <span style={{ color: "#999", lineHeight: 1.4 }}>{l.msg}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
