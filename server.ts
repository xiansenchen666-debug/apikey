// Deno Deploy: Meapi API Key 余额查看器
// 必填环境变量: MEAPI_API_KEY
// 可选环境变量: KEY_NAME, API_BASE_URL, PUBLIC_QUOTA_LIMIT, REAL_QUOTA_LIMIT, SCALE_USAGE_TO_PUBLIC_QUOTA, ESTIMATE_PRICE_PER_1M_TOKENS, DAYS, TIMEZONE, CACHE_SECONDS

type Rec = Record<string, unknown>;

function nenv(name: string, def: number): number {
  const v = Deno.env.get(name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

function benv(name: string, def = true): boolean {
  const v = Deno.env.get(name);
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

const CFG = {
  keyName: Deno.env.get("KEY_NAME") || "老弟朋友",
  apiBaseUrl: Deno.env.get("API_BASE_URL") || "https://meapi.space",
  apiKey: Deno.env.get("MEAPI_API_KEY") || "",
  days: nenv("DAYS", 30),
  timezone: Deno.env.get("TIMEZONE") || "Asia/Shanghai",
  publicLimit: nenv("PUBLIC_QUOTA_LIMIT", 50),
  realLimit: nenv("REAL_QUOTA_LIMIT", 30),
  scaleEnabled: benv("SCALE_USAGE_TO_PUBLIC_QUOTA", true),
  tokenPrice: nenv("ESTIMATE_PRICE_PER_1M_TOKENS", 0.12),
  cacheSeconds: nenv("CACHE_SECONDS", 20),
};

let cache: { t: number; payload: Rec } | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function moneyNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mask(k: string): string {
  if (!k) return "未配置 MEAPI_API_KEY";
  return k.length > 16 ? k.slice(0, 7) + "****" + k.slice(-6) : k.slice(0, 4) + "****";
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

async function usage(force = false): Promise<Rec> {
  if (!CFG.apiKey) throw new Error("Deno 环境变量 MEAPI_API_KEY 还没配置");
  const now = Date.now();
  if (!force && cache && now - cache.t < CFG.cacheSeconds * 1000) return { ...cache.payload, cached: true };

  const end = new Date();
  const start = new Date(end.getTime() - CFG.days * 86400000);
  const url = new URL("/v1/usage", CFG.apiBaseUrl.replace(/\/$/, ""));
  url.searchParams.set("start_date", ymd(start));
  url.searchParams.set("end_date", ymd(end));
  url.searchParams.set("days", String(CFG.days));
  url.searchParams.set("timezone", CFG.timezone);

  const r = await fetch(url, { headers: { authorization: "Bearer " + CFG.apiKey, accept: "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error("Meapi HTTP " + r.status + ": " + text);
  const raw = JSON.parse(text) as Rec;
  const rawQuota = (typeof raw.quota === "object" && raw.quota ? raw.quota : {}) as Rec;

  const realLimit = CFG.realLimit || moneyNum(rawQuota.limit) || 30;
  const factor = CFG.scaleEnabled ? CFG.publicLimit / realLimit : 1;
  const scaled = (v: unknown): unknown => {
    const x = moneyNum(v);
    return x == null ? v ?? null : Math.round(x * factor * 1e8) / 1e8;
  };

  const remaining = scaled(rawQuota.remaining ?? raw.remaining);
  const limit = CFG.scaleEnabled ? CFG.publicLimit : rawQuota.limit;
  let used: unknown = rawQuota.used != null ? scaled(rawQuota.used) : null;
  if (used == null && moneyNum(limit) != null && moneyNum(remaining) != null) used = Math.round((moneyNum(limit)! - moneyNum(remaining)!) * 1e8) / 1e8;

  const data = deepClone(raw) as Rec;
  const q = (typeof data.quota === "object" && data.quota ? data.quota : {}) as Rec;
  q.remaining = remaining; q.limit = limit; q.used = used;
  data.quota = q; data.remaining = remaining;

  const scaleMoney = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const a = o as Rec;
    for (const k of ["cost", "actual_cost", "account_cost"]) if (k in a) a[k] = scaled(a[k]);
  };
  const u = data.usage as Rec | undefined;
  if (u) { scaleMoney(u.today); scaleMoney(u.total); }
  if (Array.isArray(data.daily_usage)) data.daily_usage.forEach(scaleMoney);
  if (Array.isArray(data.model_stats)) data.model_stats.forEach(scaleMoney);

  const rem = moneyNum(remaining);
  const payload: Rec = {
    ok: true,
    cached: false,
    fetched_at: new Date().toISOString(),
    key_name: CFG.keyName,
    masked_key: mask(CFG.apiKey),
    estimated_remaining_tokens: rem == null ? null : Math.floor(rem / CFG.tokenPrice * 1_000_000),
    estimate_price_per_1m_tokens_usd: CFG.tokenPrice,
    quota_scale: { enabled: CFG.scaleEnabled, real_quota_limit: realLimit, public_quota_limit: CFG.publicLimit, factor },
    summary: { is_valid: raw.isValid, status: raw.status, mode: raw.mode, unit: raw.unit ?? rawQuota.unit ?? "USD", remaining, limit, used },
    data,
  };
  cache = { t: now, payload };
  return payload;
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meapi余额查看器</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#111827;font-family:Microsoft YaHei,Segoe UI,Arial}.wrap{max-width:1100px;margin:auto;padding:28px 16px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}h1{margin:0 0 6px;font-size:28px}p{margin:0;color:#6b7280}.btn{border:0;border-radius:12px;background:#2563eb;color:white;padding:11px 16px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card{background:white;border:1px solid #e5e7eb;border-radius:18px;padding:18px;box-shadow:0 12px 35px #0f172a14}.wide{grid-column:1/-1}.label{font-size:13px;color:#6b7280;margin-bottom:8px}.value{font-size:28px;font-weight:850;word-break:break-all}.green{color:#059669}.amber{color:#d97706}.small{font-size:13px;color:#6b7280;margin-top:8px}.progress{height:13px;border-radius:99px;background:#e5e7eb;overflow:hidden;margin-top:14px}.bar{height:100%;background:linear-gradient(90deg,#10b981,#22c55e);width:0}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:10px;border-bottom:1px solid #e5e7eb;text-align:left}th{font-size:12px;color:#6b7280}.err{display:none;background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:14px;padding:14px;margin:14px 0;white-space:pre-wrap}.status{display:inline-block;border-radius:999px;background:#dcfce7;color:#166534;padding:5px 10px;font-weight:800}.mono{font-family:Consolas,monospace}.section{margin:24px 0 12px;font-size:18px;font-weight:800}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:520px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.value{font-size:23px}}</style></head><body><div class="wrap"><div class="top"><div><h1>Meapi API Key 余额查看器</h1><p>对外展示50额度，后端按真实30额度线性换算。</p></div><button id="refresh" class="btn">刷新余额</button></div><div id="err" class="err"></div><div class="grid"><div class="card"><div class="label">剩余额度</div><div id="remaining" class="value green">--</div><div id="sub" class="small">等待查询</div></div><div class="card"><div class="label">总额度</div><div id="limit" class="value">--</div><div class="small">对外显示额度</div></div><div class="card"><div class="label">已用额度</div><div id="used" class="value amber">--</div><div class="small">按比例换算</div></div><div class="card"><div class="label">估算可用tokens</div><div id="tokens" class="value">--</div><div id="tokenSub" class="small">按配置单价估算</div></div><div class="card wide"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><div class="label">API Key</div><div id="key" class="mono">--</div></div><div><div class="label">状态</div><div id="status" class="status">--</div></div><div><div class="label">更新时间</div><div id="time">--</div></div></div><div class="progress"><div id="bar" class="bar"></div></div></div><div class="card"><div class="label">今日请求</div><div id="todayReq" class="value">--</div></div><div class="card"><div class="label">今日tokens</div><div id="todayTok" class="value">--</div></div><div class="card"><div class="label">今日实际消费</div><div id="todayCost" class="value">--</div></div><div class="card"><div class="label">近30天实际消费</div><div id="totalCost" class="value">--</div></div></div><div class="section">模型用量</div><div class="card wide"><table><thead><tr><th>模型</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读</th><th>总tokens</th><th>实际消费</th></tr></thead><tbody id="models"></tbody></table></div><div class="section">每日用量</div><div class="card wide"><table><thead><tr><th>日期</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读</th><th>总tokens</th><th>实际消费</th></tr></thead><tbody id="daily"></tbody></table></div></div><script>const $=id=>document.getElementById(id),num=v=>v==null||isNaN(Number(v))?'--':Number(v).toLocaleString('zh-CN'),money=(v,u='USD')=>v==null||isNaN(Number(v))?'--':(u==='USD'?'$':'')+Number(v).toFixed(6).replace(/0+$/,'').replace(/\.$/,''),row=a=>'<tr>'+a.map(x=>'<td>'+x+'</td>').join('')+'</tr>';async function load(force=false){$('refresh').disabled=true;$('refresh').textContent='查询中...';$('err').style.display='none';try{const r=await fetch('/api/usage'+(force?'?force=1':'')),j=await r.json();if(!j.ok)throw new Error(j.error||'查询失败');const s=j.summary||{},d=j.data||{},u=s.unit||'USD',today=d.usage?.today||{},total=d.usage?.total||{};$('remaining').textContent=money(s.remaining,u);$('limit').textContent=money(s.limit,u);$('used').textContent=money(s.used,u);$('sub').textContent=(j.key_name||'')+' · 比例 '+((j.quota_scale&&j.quota_scale.factor)||1).toFixed(6);$('tokens').textContent=num(j.estimated_remaining_tokens);$('tokenSub').textContent='按 $'+j.estimate_price_per_1m_tokens_usd+'/1M tokens 估算';$('key').textContent=j.masked_key||'--';$('status').textContent=(s.status||'unknown')+(s.is_valid?' · 有效':'');$('time').textContent=j.fetched_at+(j.cached?' · 缓存':'');$('todayReq').textContent=num(today.requests);$('todayTok').textContent=num(today.total_tokens);$('todayCost').textContent=money(today.actual_cost,u);$('totalCost').textContent=money(total.actual_cost,u);$('bar').style.width=s.limit?Math.max(0,Math.min(100,Number(s.remaining)/Number(s.limit)*100))+'%':'0%';let models=Array.isArray(d.model_stats)?d.model_stats:[];$('models').innerHTML=models.length?models.map(m=>row([m.model||'--',num(m.requests),num(m.input_tokens),num(m.output_tokens),num(m.cache_read_tokens),num(m.total_tokens),money(m.actual_cost,u)])).join(''):row(['暂无数据','','','','','','']);let daily=Array.isArray(d.daily_usage)?d.daily_usage:[];$('daily').innerHTML=daily.length?daily.slice().reverse().map(x=>row([x.date||'--',num(x.requests),num(x.input_tokens),num(x.output_tokens),num(x.cache_read_tokens),num(x.total_tokens),money(x.actual_cost,u)])).join(''):row(['暂无数据','','','','','','']);}catch(e){$('err').textContent=e.message||String(e);$('err').style.display='block'}finally{$('refresh').disabled=false;$('refresh').textContent='刷新余额'}}$('refresh').onclick=()=>load(true);load();setInterval(()=>load(false),30000)</script></body></html>`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" } });
  if (url.pathname === "/api/usage" || url.pathname === "/api/balance") {
    try { return json(await usage(["1", "true", "yes"].includes((url.searchParams.get("force") || "").toLowerCase()))); }
    catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
  }
  if (url.pathname === "/health") return json({ ok: true });
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});
