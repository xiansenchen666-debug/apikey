# -*- coding: utf-8 -*-
from __future__ import annotations

import datetime as dt
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
CACHE = {"time": 0.0, "payload": None}


def load_config():
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    cfg.setdefault("api_base_url", "https://meapi.space")
    cfg.setdefault("timezone", "Asia/Shanghai")
    cfg.setdefault("days", 30)
    cfg.setdefault("listen_host", "0.0.0.0")
    cfg.setdefault("port", 8787)
    cfg.setdefault("cache_seconds", 20)
    cfg.setdefault("estimate_price_per_1m_tokens_usd", 0.12)
    return cfg


def mask_key(key: str) -> str:
    if not key:
        return ""
    return key[:7] + "****" + key[-6:]


def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def query_usage(force=False):
    cfg = load_config()
    now = time.time()
    cache_seconds = int(cfg.get("cache_seconds", 20) or 0)
    if not force and CACHE["payload"] is not None and now - CACHE["time"] < cache_seconds:
        payload = dict(CACHE["payload"])
        payload["cached"] = True
        return payload

    end = dt.date.today()
    start = end - dt.timedelta(days=int(cfg["days"]))
    params = urllib.parse.urlencode({
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "days": cfg["days"],
        "timezone": cfg["timezone"],
    })
    url = cfg["api_base_url"].rstrip("/") + "/v1/usage?" + params
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + cfg["api_key"],
        "Accept": "application/json",
        "User-Agent": "meapi-balance-viewer/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("Meapi HTTP %s: %s" % (e.code, e.read().decode("utf-8", errors="replace")))

    quota = data.get("quota") or {}
    raw_remaining = quota.get("remaining", data.get("remaining"))
    raw_limit = quota.get("limit")
    raw_used = quota.get("used")

    # ????????? key ?? 30????????? 50?
    # ???? x -> ???? x * 50 / 30????? y -> ???? y * 50 / 30?
    public_limit = cfg.get("public_quota_limit")
    real_limit = cfg.get("real_quota_limit") or raw_limit
    scale_enabled = bool(cfg.get("scale_usage_to_public_quota", False))
    scale = 1.0
    if scale_enabled and public_limit is not None and real_limit:
        scale = float(public_limit) / float(real_limit)

    def scaled(v):
        if v is None:
            return None
        try:
            return round(float(v) * scale, 8)
        except Exception:
            return v

    remaining = scaled(raw_remaining)
    limit = float(public_limit) if scale_enabled and public_limit is not None else raw_limit
    if raw_used is not None:
        used = scaled(raw_used)
    elif limit is not None and remaining is not None:
        used = round(float(limit) - float(remaining), 8)
    else:
        used = None

    display_data = json.loads(json.dumps(data, ensure_ascii=False))
    display_quota = display_data.get("quota") or {}
    if isinstance(display_quota, dict):
        display_quota["remaining"] = remaining
        display_quota["limit"] = limit
        display_quota["used"] = used
        display_data["quota"] = display_quota
        display_data["remaining"] = remaining

    def scale_money_fields(obj):
        if isinstance(obj, dict):
            for k in ("cost", "actual_cost", "account_cost"):
                if k in obj:
                    obj[k] = scaled(obj[k])
        return obj

    usage = display_data.get("usage") or {}
    if isinstance(usage, dict):
        scale_money_fields(usage.get("today") or {})
        scale_money_fields(usage.get("total") or {})
    for item in display_data.get("daily_usage") or []:
        scale_money_fields(item)
    for item in display_data.get("model_stats") or []:
        scale_money_fields(item)

    price = float(cfg.get("estimate_price_per_1m_tokens_usd") or 0.12)
    est_tokens = None
    try:
        est_tokens = int(float(remaining) / price * 1000000) if remaining is not None and price > 0 else None
    except Exception:
        pass

    payload = {
        "ok": True,
        "cached": False,
        "fetched_at": dt.datetime.now().isoformat(timespec="seconds"),
        "key_name": cfg.get("key_name", "API Key"),
        "masked_key": mask_key(cfg.get("api_key", "")),
        "api_base_url": cfg.get("api_base_url"),
        "estimate_price_per_1m_tokens_usd": price,
        "estimated_remaining_tokens": est_tokens,
        "quota_scale": {
            "enabled": scale_enabled,
            "real_quota_limit": real_limit,
            "public_quota_limit": public_limit,
            "factor": scale,
        },
        "summary": {
            "is_valid": data.get("isValid"),
            "status": data.get("status"),
            "mode": data.get("mode"),
            "unit": data.get("unit") or quota.get("unit") or "USD",
            "remaining": remaining,
            "limit": limit,
            "used": used,
        },
        "data": display_data,
    }
    CACHE["time"] = now
    CACHE["payload"] = payload
    return payload


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/api/usage", "/api/balance"):
            force = urllib.parse.parse_qs(parsed.query).get("force", [""])[0] in ("1", "true", "yes")
            try:
                self.send_json(query_usage(force=force))
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (dt.datetime.now().strftime("%H:%M:%S"), fmt % args))


def main():
    cfg = load_config()
    port = int(cfg["port"])
    host = cfg.get("listen_host", "0.0.0.0")
    print("=" * 60)
    print(cfg.get("title", "Meapi API Key 余额查看器"))
    print("本机访问:  http://127.0.0.1:%d" % port)
    print("局域网访问: http://%s:%d" % (get_lan_ip(), port))
    print("API Key:   %s" % mask_key(cfg.get("api_key", "")))
    print("按 Ctrl+C 停止服务")
    print("=" * 60)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()

