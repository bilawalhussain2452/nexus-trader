import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// BINANCE PUBLIC API — no API key required
// ============================================================
const BINANCE_API = "https://api.binance.com/api/v3";

async function fetchTopMovers() {
  try {
    const res = await fetch(`${BINANCE_API}/ticker/24hr`);
    const data = await res.json();
    const usdt = data
      .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("DOWN") && !t.symbol.includes("UP") && !t.symbol.includes("BULL") && !t.symbol.includes("BEAR"))
      .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
      .slice(0, 2)
      .map((t) => ({ symbol: t.symbol, label: t.symbol.replace("USDT", "/USDT"), price: parseFloat(t.lastPrice), changePercent: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) }));
    return usdt;
  } catch { return [{ symbol: "BTCUSDT", label: "BTC/USDT", price: 67000, changePercent: 0, volume: 0 }, { symbol: "ETHUSDT", label: "ETH/USDT", price: 3500, changePercent: 0, volume: 0 }]; }
}

async function searchPairs(query) {
  try {
    const res = await fetch(`${BINANCE_API}/ticker/24hr`);
    const data = await res.json();
    const q = query.toUpperCase().replace("/", "").replace("-", "");
    return data
      .filter((t) => t.symbol.endsWith("USDT") && t.symbol.includes(q) && !t.symbol.includes("DOWN") && !t.symbol.includes("UP"))
      .slice(0, 6)
      .map((t) => ({ symbol: t.symbol, label: t.symbol.replace("USDT", "/USDT"), price: parseFloat(t.lastPrice), changePercent: parseFloat(t.priceChangePercent) }));
  } catch { return []; }
}

async function fetchKlines(symbol, interval = "5m", limit = 100) {
  try {
    const res = await fetch(`${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const data = await res.json();
    return data.map((k) => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
  } catch { return []; }
}

async function fetchTicker(symbol) {
  try {
    const res = await fetch(`${BINANCE_API}/ticker/24hr?symbol=${symbol}`);
    const d = await res.json();
    return { price: parseFloat(d.lastPrice), changePercent: parseFloat(d.priceChangePercent), high: parseFloat(d.highPrice), low: parseFloat(d.lowPrice), volume: parseFloat(d.quoteVolume) };
  } catch { return null; }
}

// ============================================================
// TRADING ENGINE
// ============================================================
const TE = {
  EMA: (data, period) => {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
    return ema;
  },
  RSI: (prices, period = 14) => {
    if (prices.length < period + 1) return 50;
    const changes = prices.slice(1).map((p, i) => p - prices[i]);
    const gains = changes.map((c) => (c > 0 ? c : 0));
    const losses = changes.map((c) => (c < 0 ? Math.abs(c) : 0));
    const ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  },
  BB: (prices, period = 20) => {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period);
    return { upper: sma + 2 * std, middle: sma, lower: sma - 2 * std };
  },
  ATR: (highs, lows, closes, period = 14) => {
    if (closes.length < period + 1) return closes[closes.length - 1] * 0.01;
    const trs = closes.slice(1).map((_, i) => Math.max(highs[i + 1] - lows[i + 1], Math.abs(highs[i + 1] - closes[i]), Math.abs(lows[i + 1] - closes[i])));
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  },
  analyze: (closes, highs, lows) => {
    if (closes.length < 50) return { signal: "WAIT", confidence: 0, rsi: 50, bb: null, ema20: null, ema50: null };
    const rsi = TE.RSI(closes);
    const ema20 = TE.EMA(closes, 20);
    const ema50 = TE.EMA(closes, 50);
    const bb = TE.BB(closes);
    const price = closes[closes.length - 1];
    const atr = TE.ATR(highs, lows, closes);
    let score = 0, signals = 0;
    // Trend
    if (ema20 && ema50) { signals++; if (ema20 > ema50 && price > ema20) score += 1; else if (ema20 < ema50 && price < ema20) score -= 1; }
    // RSI
    signals++; if (rsi < 35) score += 1; else if (rsi > 65) score -= 1;
    // BB
    if (bb) { signals++; if (price < bb.lower) score += 1; else if (price > bb.upper) score -= 1; }
    // Recent momentum
    if (closes.length >= 3) { signals++; const mom = (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4] * 100; if (mom > 0.3) score += 1; else if (mom < -0.3) score -= 1; }
    const ratio = score / signals;
    let signal = "HOLD", confidence = 40;
    if (ratio >= 0.5) { signal = "BUY"; confidence = 50 + ratio * 45; }
    else if (ratio <= -0.5) { signal = "SELL"; confidence = 50 + Math.abs(ratio) * 45; }
    const sl = signal === "BUY" ? price - atr * 2 : price + atr * 2;
    const tp = signal === "BUY" ? price + atr * 3 : price - atr * 3;
    return { signal, confidence: Math.min(95, confidence), rsi, bb, ema20, ema50, sl, tp, atr };
  },
};

// ============================================================
// MINI CHART
// ============================================================
const MiniSparkline = ({ prices, height = 40, width = 100 }) => {
  if (!prices || prices.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
  const pts = prices.map((p, i) => `${(i / (prices.length - 1)) * width},${height - ((p - min) / range) * height * 0.9 - height * 0.05}`).join(" ");
  const isUp = prices[prices.length - 1] >= prices[0];
  const c = isUp ? "#00e87a" : "#ff3d5a";
  return (
    <svg width={width} height={height}>
      <defs><linearGradient id={`sg${width}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity="0.18" /><stop offset="100%" stopColor={c} stopOpacity="0" /></linearGradient></defs>
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#sg${width})`} />
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
};

// ============================================================
// SIGNAL BADGE
// ============================================================
const Badge = ({ s, conf }) => {
  const cfg = { BUY: ["#00e87a", "#0a2118"], SELL: ["#ff3d5a", "#220a0f"], HOLD: ["#f5c518", "#1e1900"], WAIT: ["#666", "#111"] };
  const [fg, bg] = cfg[s] || cfg.HOLD;
  return <span style={{ fontFamily: "monospace", fontSize: 10, fontWeight: 800, letterSpacing: 1.5, padding: "3px 9px", borderRadius: 3, background: bg, color: fg, border: `1px solid ${fg}44` }}>{s === "BUY" ? "▲ " : s === "SELL" ? "▼ " : "◆ "}{s}{conf > 0 ? ` ${conf.toFixed(0)}%` : ""}</span>;
};

// ============================================================
// PAIR CARD
// ============================================================
const PairCard = ({ pair, analysis, isActive, isAuto, onSelect, onRemove }) => {
  const pct = pair.changePercent || 0;
  const isUp = pct >= 0;
  return (
    <div onClick={onSelect} style={{ cursor: "pointer", padding: "12px 14px", borderRadius: 10, border: `1px solid ${isActive ? "rgba(0,232,122,0.35)" : "rgba(255,255,255,0.07)"}`, background: isActive ? "rgba(0,232,122,0.04)" : "rgba(255,255,255,0.02)", transition: "all 0.2s", position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: isActive ? "#00e87a" : "#ddd", fontFamily: "'DM Mono', monospace" }}>{pair.label}</span>
            {isAuto && <span style={{ fontSize: 8, padding: "1px 5px", background: "rgba(245,197,24,0.15)", color: "#f5c518", borderRadius: 3, fontFamily: "monospace", letterSpacing: 1 }}>AUTO</span>}
          </div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", fontFamily: "'DM Mono', monospace", marginTop: 2 }}>
            ${pair.price < 1 ? pair.price.toFixed(6) : pair.price < 100 ? pair.price.toFixed(4) : pair.price.toFixed(2)}
          </div>
          <div style={{ fontSize: 10, fontFamily: "monospace", color: isUp ? "#00e87a" : "#ff3d5a", marginTop: 1 }}>{isUp ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}% 24h</div>
        </div>
        <div style={{ textAlign: "right" }}>
          {analysis && <Badge s={analysis.signal} conf={analysis.confidence} />}
          <MiniSparkline prices={pair.closes || []} width={90} height={38} />
        </div>
      </div>
      {!isAuto && (
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ position: "absolute", top: 6, right: 6, background: "rgba(255,61,90,0.15)", border: "1px solid rgba(255,61,90,0.3)", color: "#ff3d5a", borderRadius: 4, width: 18, height: 18, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>
      )}
    </div>
  );
};

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [pairs, setPairs] = useState([]); // [{symbol, label, price, changePercent, closes:[], highs:[], lows:[], isAuto}]
  const [analyses, setAnalyses] = useState({});
  const [activePair, setActivePair] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [mode, setMode] = useState("CONSERVATIVE");
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [tick, setTick] = useState(0);
  const intervalRef = useRef(null);
  const searchTimeout = useRef(null);

  const log = useCallback((type, msg) => {
    const t = new Date();
    const time = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
    setLogs((prev) => [{ type, msg, time, id: Math.random() }, ...prev].slice(0, 60));
  }, []);

  // Init: fetch top 2 movers
  useEffect(() => {
    (async () => {
      setLoading(true);
      log("SYS", "Fetching top movers from Binance...");
      const movers = await fetchTopMovers();
      const enriched = await Promise.all(movers.map(async (m) => {
        const klines = await fetchKlines(m.symbol, "5m", 100);
        return { ...m, closes: klines.map((k) => k.close), highs: klines.map((k) => k.high), lows: klines.map((k) => k.low), isAuto: true };
      }));
      setPairs(enriched);
      setActivePair(enriched[0]?.symbol || null);
      const a = {};
      enriched.forEach((p) => { a[p.symbol] = TE.analyze(p.closes, p.highs, p.lows); });
      setAnalyses(a);
      log("INFO", `Auto-loaded: ${enriched.map((p) => p.label).join(", ")}`);
      setLoading(false);
    })();
  }, []);

  // Search handler
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    clearTimeout(searchTimeout.current);
    setSearching(true);
    searchTimeout.current = setTimeout(async () => {
      const results = await searchPairs(searchQuery);
      setSearchResults(results);
      setSearching(false);
    }, 500);
  }, [searchQuery]);

  const addManualPair = async (pair) => {
    if (pairs.length >= 4) { log("WARN", "Max 4 pairs. Remove one first."); return; }
    if (pairs.find((p) => p.symbol === pair.symbol)) { log("WARN", `${pair.label} already added.`); return; }
    log("INFO", `Loading ${pair.label}...`);
    const klines = await fetchKlines(pair.symbol, "5m", 100);
    const enriched = { ...pair, closes: klines.map((k) => k.close), highs: klines.map((k) => k.high), lows: klines.map((k) => k.low), isAuto: false };
    setPairs((prev) => [...prev, enriched]);
    setAnalyses((prev) => ({ ...prev, [pair.symbol]: TE.analyze(enriched.closes, enriched.highs, enriched.lows) }));
    setActivePair(pair.symbol);
    setShowSearch(false);
    setSearchQuery("");
    setSearchResults([]);
    log("INFO", `${pair.label} added successfully.`);
  };

  const removePair = (symbol) => {
    setPairs((prev) => prev.filter((p) => p.symbol !== symbol));
    setAnalyses((prev) => { const n = { ...prev }; delete n[symbol]; return n; });
    if (activePair === symbol) setActivePair(pairs.find((p) => p.symbol !== symbol)?.symbol || null);
    log("INFO", `Removed ${symbol}`);
  };

  // Live refresh loop
  const refresh = useCallback(async () => {
    setPairs((prev) => {
      Promise.all(prev.map(async (p) => {
        const ticker = await fetchTicker(p.symbol);
        const klines = await fetchKlines(p.symbol, "5m", 100);
        if (!ticker) return p;
        const closes = klines.map((k) => k.close);
        const highs = klines.map((k) => k.high);
        const lows = klines.map((k) => k.low);
        const analysis = TE.analyze(closes, highs, lows);
        setAnalyses((a) => ({ ...a, [p.symbol]: analysis }));
        const minConf = mode === "AGGRESSIVE" ? 58 : 70;
        if (analysis.confidence >= minConf && analysis.signal !== "HOLD" && analysis.signal !== "WAIT") {
          log(analysis.signal, `${p.label} @ $${ticker.price.toFixed(2)} | Conf: ${analysis.confidence.toFixed(0)}% | SL: $${(analysis.sl||0).toFixed(2)} | TP: $${(analysis.tp||0).toFixed(2)}`);
        }
        return { ...p, price: ticker.price, changePercent: ticker.changePercent, high: ticker.high, low: ticker.low, closes, highs, lows };
      })).then((updated) => setPairs(updated));
      return prev;
    });
    setTick((t) => t + 1);
  }, [mode, log]);

  useEffect(() => {
    if (isRunning) {
      log("SYS", `Bot STARTED — ${mode} mode — refreshing every 30s`);
      refresh();
      intervalRef.current = setInterval(refresh, 30000);
    } else {
      clearInterval(intervalRef.current);
      if (tick > 0) log("SYS", "Bot PAUSED.");
    }
    return () => clearInterval(intervalRef.current);
  }, [isRunning, mode]);

  const active = pairs.find((p) => p.symbol === activePair);
  const activeAnalysis = activePair ? analyses[activePair] : null;

  return (
    <div style={{ minHeight: "100vh", background: "#07090e", color: "#e0e4ec", fontFamily: "'DM Mono', 'Courier New', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Outfit:wght@400;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#1e2330;border-radius:2px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .hov{transition:all 0.18s}.hov:hover{background:rgba(255,255,255,0.07)!important}
        input{outline:none}
      `}</style>

      {/* TOPBAR */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(7,9,14,0.95)", backdropFilter: "blur(16px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#00e87a,#00aaff)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, fontFamily: "'Outfit',sans-serif", color: "#000" }}>N</div>
          <div>
            <div style={{ fontFamily: "'Outfit',sans-serif", fontWeight: 800, fontSize: 14, letterSpacing: -0.3 }}>NEXUS TRADER</div>
            <div style={{ fontSize: 9, color: "#444", letterSpacing: 1.5 }}>BINANCE SIGNAL BOT · LIVE DATA</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: 2, gap: 2 }}>
            {["CONSERVATIVE", "AGGRESSIVE"].map((m) => (
              <button key={m} onClick={() => setMode(m)} className="hov" style={{ padding: "4px 10px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 9, fontWeight: 700, letterSpacing: 1, fontFamily: "'DM Mono',monospace", background: mode === m ? (m === "CONSERVATIVE" ? "rgba(0,232,122,0.18)" : "rgba(255,61,90,0.18)") : "transparent", color: mode === m ? (m === "CONSERVATIVE" ? "#00e87a" : "#ff3d5a") : "#444" }}>
                {m === "CONSERVATIVE" ? "🛡 SAFE" : "⚡ AGGR"}
              </button>
            ))}
          </div>
          <button onClick={() => setIsRunning((r) => !r)} className="hov" style={{ display:"flex", alignItems:"center", gap:5, padding:"6px 14px", borderRadius:6, border:`1px solid ${isRunning?"rgba(255,61,90,0.4)":"rgba(0,232,122,0.4)"}`, background: isRunning?"rgba(255,61,90,0.1)":"rgba(0,232,122,0.1)", color: isRunning?"#ff3d5a":"#00e87a", cursor:"pointer", fontSize:11, fontWeight:700, letterSpacing:1 }}>
            <span style={{ animation: isRunning ? "pulse 1s infinite" : "none" }}>{isRunning ? "■" : "▶"}</span>
            {isRunning ? "STOP" : "START"}
          </button>
        </div>
      </div>

      <div style={{ padding: "16px 20px", display: "grid", gap: 14, maxWidth: 1100, margin: "0 auto" }}>

        {/* PAIR GRID + ADD BUTTON */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 1.5 }}>TRADING PAIRS ({pairs.length}/4) · <span style={{ color: "#f5c518" }}>AUTO</span> = top movers · <span style={{ color: "#888" }}>MANUAL</span> = your picks</div>
            {pairs.length < 4 && (
              <button onClick={() => setShowSearch((s) => !s)} className="hov" style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid rgba(0,170,255,0.3)", background: "rgba(0,170,255,0.08)", color: "#00aaff", cursor: "pointer", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
                {showSearch ? "✕ CANCEL" : "+ ADD PAIR"}
              </button>
            )}
          </div>

          {/* SEARCH BOX */}
          {showSearch && (
            <div style={{ marginBottom: 12, animation: "fadeIn 0.2s ease" }}>
              <div style={{ position: "relative" }}>
                <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search pair e.g. BTC, SOL, DOGE..." style={{ width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(0,170,255,0.3)", borderRadius: 8, color: "#ddd", fontSize: 12, fontFamily: "'DM Mono',monospace" }} autoFocus />
                {searching && <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>}
              </div>
              {searchResults.length > 0 && (
                <div style={{ marginTop: 6, background: "#0d1018", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, overflow: "hidden" }}>
                  {searchResults.map((r) => (
            
