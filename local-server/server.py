#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
探究與實作期末報告平台
- 老師端：抽籤排序、計時、即時平均分數、Excel 匯出
- 學生端：掃 QR Code 後評分
- 無需 Flask；使用 Python 標準庫。QR Code 若用 uv --with qrcode[pil] 啟動則可本機產生。
"""
from __future__ import annotations

import base64
import datetime as _dt
import html
import io
import json
import math
import os
import pathlib
import random
import re
import shutil
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from xml.sax.saxutils import escape as xml_escape

APP_DIR = pathlib.Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
EXPORT_DIR = APP_DIR / "exports"
STATE_FILE = DATA_DIR / "state.json"
PORT = int(os.environ.get("REPORT_PLATFORM_PORT", "8765"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_GROUPS = [f"第{i}組" for i in range(1, 9)]
PHASES = {
    "setup": "設定中",
    "report": "報告時間",
    "question": "提問時間",
    "rating": "評分／換場時間",
    "paused": "暫停",
    "done": "已完成",
}

STATE_LOCK = threading.RLock()


def lan_ip() -> str:
    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            pass
    return ip


def now_iso() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def normalize_group_name(s: str) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s


def initial_state() -> dict[str, Any]:
    return {
        "title": "探究與實作期末報告",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "groups": DEFAULT_GROUPS,
        "report_order": [],
        "question_order": [],
        "current_index": 0,
        "phase": "setup",
        "timer": {"running": False, "phase": "setup", "duration": 0, "start_at": None, "end_at": None},
        "scores": {},  # round index as string -> scorer group -> score object
        "exports": [],
    }


def load_state() -> dict[str, Any]:
    with STATE_LOCK:
        if not STATE_FILE.exists():
            st = initial_state()
            save_state(st)
            return st
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            backup = STATE_FILE.with_suffix(".broken.json")
            shutil.copy2(STATE_FILE, backup)
            st = initial_state()
            save_state(st)
            return st


def save_state(st: dict[str, Any]) -> None:
    with STATE_LOCK:
        st["updated_at"] = now_iso()
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(STATE_FILE)


def parse_groups(raw: Any) -> list[str]:
    if isinstance(raw, str):
        items = re.split(r"[\n,，、;；]+", raw)
    elif isinstance(raw, list):
        items = raw
    else:
        items = []
    groups: list[str] = []
    seen: set[str] = set()
    for item in items:
        name = normalize_group_name(str(item))
        if name and name not in seen:
            groups.append(name)
            seen.add(name)
    return groups


def make_deranged_orders(groups: list[str]) -> tuple[list[str], list[str]]:
    """Create report/question orders where same index never has the same group."""
    groups = list(groups)
    if len(groups) < 2:
        return groups, groups
    report = groups[:]
    random.SystemRandom().shuffle(report)

    # Try random shuffles first.
    question = groups[:]
    rng = random.SystemRandom()
    for _ in range(500):
        rng.shuffle(question)
        if all(a != b for a, b in zip(report, question)):
            return report, question[:]

    # Deterministic fallback: rotate report order by one.
    question = report[1:] + report[:1]
    return report, question


def current_round(st: dict[str, Any]) -> dict[str, Any]:
    idx = int(st.get("current_index", 0) or 0)
    report_order = st.get("report_order") or []
    question_order = st.get("question_order") or []
    total = min(len(report_order), len(question_order))
    if total <= 0:
        return {"index": 0, "round_no": 0, "total": 0, "report_group": None, "question_group": None}
    idx = max(0, min(idx, total - 1))
    return {
        "index": idx,
        "round_no": idx + 1,
        "total": total,
        "report_group": report_order[idx],
        "question_group": question_order[idx],
    }


def timer_public(st: dict[str, Any]) -> dict[str, Any]:
    t = dict(st.get("timer") or {})
    running = bool(t.get("running"))
    duration = int(t.get("duration") or 0)
    end_at = t.get("end_at")
    remaining = duration
    done = False
    if running and end_at:
        remaining = max(0, int(math.ceil(float(end_at) - time.time())))
        done = remaining <= 0
    t["remaining"] = remaining
    t["done"] = done
    t["phase_label"] = PHASES.get(t.get("phase") or st.get("phase"), str(t.get("phase") or ""))
    return t


def expected_scorers(st: dict[str, Any], idx: int) -> list[str]:
    groups = st.get("groups") or []
    report = (st.get("report_order") or [None])[idx] if idx < len(st.get("report_order") or []) else None
    question = (st.get("question_order") or [None])[idx] if idx < len(st.get("question_order") or []) else None
    return [g for g in groups if g not in {report, question}]


def round_stats(st: dict[str, Any], idx: int) -> dict[str, Any]:
    scores = (st.get("scores") or {}).get(str(idx), {}) or {}
    vals = list(scores.values())
    report_scores = [float(v.get("report_score")) for v in vals if isinstance(v, dict) and v.get("report_score") is not None]
    question_scores = [float(v.get("question_score")) for v in vals if isinstance(v, dict) and v.get("question_score") is not None]
    exp = expected_scorers(st, idx) if st.get("groups") else []
    submitted = set(scores.keys())
    missing = [g for g in exp if g not in submitted]
    report_group = (st.get("report_order") or [None])[idx] if idx < len(st.get("report_order") or []) else None
    question_group = (st.get("question_order") or [None])[idx] if idx < len(st.get("question_order") or []) else None
    return {
        "index": idx,
        "round_no": idx + 1,
        "report_group": report_group,
        "question_group": question_group,
        "report_avg": round(sum(report_scores) / len(report_scores), 2) if report_scores else None,
        "question_avg": round(sum(question_scores) / len(question_scores), 2) if question_scores else None,
        "count": len(vals),
        "expected_count": len(exp),
        "missing_groups": missing,
    }


def public_state(st: dict[str, Any] | None = None) -> dict[str, Any]:
    st = st or load_state()
    cr = current_round(st)
    total = cr["total"]
    stats = [round_stats(st, i) for i in range(total)]
    out = dict(st)
    out["phase_label"] = PHASES.get(st.get("phase"), str(st.get("phase")))
    out["current_round"] = cr
    out["timer"] = timer_public(st)
    out["stats"] = stats
    out["current_stats"] = round_stats(st, cr["index"]) if total else None
    out["student_url_hint"] = f"http://{lan_ip()}:{PORT}/student"
    out["teacher_url_hint"] = f"http://{lan_ip()}:{PORT}/"
    out["drive_dir"] = str(find_drive_dir() or "")
    return out


def find_drive_dir() -> pathlib.Path | None:
    env = os.environ.get("REPORT_PLATFORM_DRIVE_DIR")
    if env:
        p = pathlib.Path(env)
        if p.exists():
            return p
    home = pathlib.Path.home()
    candidates = [
        home / "Google Drive",
        home / "GoogleDrive",
        home / "My Drive",
        home / "我的雲端硬碟",
        home / "Google 雲端硬碟",
        home / "Drive",
        home / "Documents" / "Google Drive",
        home / "Desktop" / "Google Drive",
    ]
    # Google Drive for desktop on Windows often mounts as G:/我的雲端硬碟
    # or another drive letter. Check common drive letters as well.
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        root = pathlib.Path(f"{letter}:/")
        candidates.extend([
            root / "我的雲端硬碟",
            root / "My Drive",
            root / "Google Drive",
        ])
    for p in candidates:
        if p.exists():
            return p
    return None


def start_timer(st: dict[str, Any], phase: str, duration: int) -> dict[str, Any]:
    st["phase"] = phase
    st["timer"] = {
        "running": True,
        "phase": phase,
        "duration": int(duration),
        "start_at": time.time(),
        "end_at": time.time() + int(duration),
    }
    save_state(st)
    return st


def safe_sheet_name(name: str) -> str:
    name = re.sub(r"[\\/*?:\[\]]", "_", name)[:31]
    return name or "Sheet"


def col_name(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def cell_xml(value: Any, ref: str) -> str:
    if value is None:
        return f'<c r="{ref}"/>'
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"><v>{value}</v></c>'
    text = xml_escape(str(value))
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def sheet_xml(rows: list[list[Any]]) -> str:
    row_xml = []
    for r_idx, row in enumerate(rows, 1):
        cells = []
        for c_idx, value in enumerate(row, 1):
            ref = f"{col_name(c_idx)}{r_idx}"
            cells.append(cell_xml(value, ref))
        row_xml.append(f'<row r="{r_idx}">{"".join(cells)}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="18"/>'
        f'<sheetData>{"".join(row_xml)}</sheetData>'
        '</worksheet>'
    )


def build_excel(st: dict[str, Any]) -> bytes:
    title = st.get("title") or "探究與實作期末報告"
    groups = st.get("groups") or []
    report_order = st.get("report_order") or []
    question_order = st.get("question_order") or []
    total = min(len(report_order), len(question_order))
    stats = [round_stats(st, i) for i in range(total)]
    scores = st.get("scores") or {}

    summary_rows: list[list[Any]] = [
        [title],
        ["匯出時間", now_iso()],
        [],
        ["順位", "報告組別", "提問組別", "報告平均分", "提問平均分", "已評分組數", "應評分組數", "未評分組別"],
    ]
    for s in stats:
        summary_rows.append([
            s["round_no"], s["report_group"], s["question_group"], s["report_avg"], s["question_avg"],
            s["count"], s["expected_count"], "、".join(s["missing_groups"]),
        ])

    group_rows: list[list[Any]] = [["組別", "報告順位", "報告平均分", "提問順位", "提問平均分"]]
    for g in groups:
        report_idx = report_order.index(g) if g in report_order else None
        question_idx = question_order.index(g) if g in question_order else None
        group_rows.append([
            g,
            report_idx + 1 if report_idx is not None else "",
            stats[report_idx]["report_avg"] if report_idx is not None and report_idx < len(stats) else "",
            question_idx + 1 if question_idx is not None else "",
            stats[question_idx]["question_avg"] if question_idx is not None and question_idx < len(stats) else "",
        ])

    raw_rows: list[list[Any]] = [["順位", "報告組別", "提問組別", "評分組別", "報告分數", "提問分數", "送出時間", "備註"]]
    for i in range(total):
        round_scores = scores.get(str(i), {}) or {}
        for scorer, v in sorted(round_scores.items()):
            raw_rows.append([
                i + 1, report_order[i], question_order[i], scorer,
                v.get("report_score"), v.get("question_score"), v.get("submitted_at"), v.get("comment", ""),
            ])

    order_rows: list[list[Any]] = [["順位", "報告組別", "提問組別", "是否衝突"]]
    for i in range(total):
        order_rows.append([i + 1, report_order[i], question_order[i], "衝突" if report_order[i] == question_order[i] else "OK"])

    sheets = [
        ("總表", summary_rows),
        ("組別總結", group_rows),
        ("原始評分", raw_rows),
        ("抽籤排序", order_rows),
    ]
    workbook_sheets = []
    rels = []
    overrides = []
    files: dict[str, str] = {}
    for idx, (name, rows) in enumerate(sheets, 1):
        sname = safe_sheet_name(name)
        workbook_sheets.append(f'<sheet name="{xml_escape(sname)}" sheetId="{idx}" r:id="rId{idx}"/>')
        rels.append(f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>')
        overrides.append(f'<Override PartName="/xl/worksheets/sheet{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        files[f"xl/worksheets/sheet{idx}.xml"] = sheet_xml(rows)

    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(workbook_sheets)}</sheets></workbook>'
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{"".join(rels)}</Relationships>'
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        '</Relationships>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        f'{"".join(overrides)}</Types>'
    )
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f'<dc:title>{xml_escape(title)} 評分資料</dc:title><dc:creator>Hermes Agent</dc:creator>'
        f'<cp:lastModifiedBy>Hermes Agent</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">{_dt.datetime.utcnow().isoformat()}Z</dcterms:created>'
        '</cp:coreProperties>'
    )
    app = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Hermes Agent</Application></Properties>'
    )

    bio = io.BytesIO()
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", workbook_xml)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("docProps/core.xml", core)
        z.writestr("docProps/app.xml", app)
        for path, content in files.items():
            z.writestr(path, content)
    return bio.getvalue()


def export_excel(st: dict[str, Any]) -> dict[str, Any]:
    stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = re.sub(r"[\\/:*?\"<>|\s]+", "_", st.get("title") or "探究期末報告評分").strip("_")
    filename = f"{safe_title}_評分資料_{stamp}.xlsx"
    data = build_excel(st)
    out = EXPORT_DIR / filename
    out.write_bytes(data)
    latest = EXPORT_DIR / "latest.xlsx"
    latest.write_bytes(data)

    drive_path = None
    drive_dir = find_drive_dir()
    if drive_dir:
        target_dir = drive_dir / "探究與實作期末報告評分資料"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / filename
        target.write_bytes(data)
        (target_dir / "latest.xlsx").write_bytes(data)
        drive_path = str(target)

    rec = {"created_at": now_iso(), "path": str(out), "latest": str(latest), "drive_path": drive_path, "bytes": len(data)}
    st.setdefault("exports", []).append(rec)
    save_state(st)
    return rec


TEACHER_HTML = r"""
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>探究與實作期末報告平台｜老師端</title>
  <style>
    :root{
      --bg:#08111f; --panel:#101c31; --panel2:#13243d; --ink:#f4f7fb; --muted:#a8b3c7;
      --accent:#5eead4; --accent2:#60a5fa; --warn:#fbbf24; --danger:#fb7185; --ok:#86efac;
      --line:rgba(255,255,255,.11); --shadow:0 20px 60px rgba(0,0,0,.32);
    }
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 12% 8%,#1d3b62 0,#08111f 34%,#060b14 100%);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif;}
    .wrap{max-width:1320px;margin:0 auto;padding:22px}.hero{display:flex;gap:18px;align-items:stretch;justify-content:space-between;margin-bottom:18px}.card{background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.035));border:1px solid var(--line);box-shadow:var(--shadow);border-radius:24px;padding:20px}.hero .main{flex:1}.eyebrow{color:var(--accent);font-weight:800;letter-spacing:.08em}.title{font-size:clamp(30px,4.5vw,58px);line-height:1.05;margin:8px 0 10px;font-weight:950}.sub{color:var(--muted);font-size:17px}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{border:none;border-radius:14px;padding:12px 16px;background:#1f2f4d;color:var(--ink);font-weight:850;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.22)}.btn:hover{filter:brightness(1.12)}.btn.primary{background:linear-gradient(135deg,#14b8a6,#2563eb)}.btn.warn{background:linear-gradient(135deg,#f59e0b,#ef4444)}.btn.ok{background:linear-gradient(135deg,#16a34a,#0d9488)}.btn.ghost{background:transparent;border:1px solid var(--line)}.btn.small{padding:8px 11px;border-radius:11px;font-size:13px}textarea,input{width:100%;background:#07101d;border:1px solid var(--line);color:var(--ink);border-radius:14px;padding:12px 13px;font:inherit}textarea{min-height:145px;resize:vertical}.label{display:block;font-weight:800;margin:10px 0 7px}.muted{color:var(--muted)}.bigRound{display:grid;grid-template-columns:1fr 1fr;gap:14px}.roleBox{padding:22px;border-radius:22px;background:rgba(255,255,255,.06);border:1px solid var(--line);min-height:120px}.roleBox .role{color:var(--muted);font-weight:800}.roleBox .group{font-size:clamp(30px,5vw,54px);font-weight:950;margin-top:8px}.report{border-color:rgba(94,234,212,.55)}.question{border-color:rgba(96,165,250,.55)}.timer{font-variant-numeric:tabular-nums;font-size:clamp(54px,9vw,112px);font-weight:1000;text-align:center;line-height:1;margin:12px 0;color:#fff;text-shadow:0 0 30px rgba(94,234,212,.25)}.phase{text-align:center;font-weight:900;color:var(--accent);font-size:22px}.progress{height:12px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}.bar{height:100%;width:0;background:linear-gradient(90deg,#5eead4,#60a5fa,#c084fc)}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:10px 9px;text-align:left}th{color:#cbd5e1;background:rgba(255,255,255,.04);position:sticky;top:0}tr.conflict td{background:rgba(251,113,133,.16)}.pill{display:inline-flex;border-radius:999px;padding:5px 10px;font-weight:900;background:rgba(255,255,255,.08);border:1px solid var(--line)}.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.score{font-size:32px;font-weight:950}.qr{display:grid;grid-template-columns:210px 1fr;gap:16px;align-items:center}.qr img{width:210px;height:210px;background:white;border-radius:18px;padding:10px}.url{word-break:break-all;background:rgba(0,0,0,.22);border-radius:13px;padding:10px;color:#dbeafe}.footer{color:var(--muted);font-size:13px;text-align:center;margin:18px}.toast{position:fixed;right:18px;bottom:18px;background:#0f172a;border:1px solid var(--line);padding:14px 16px;border-radius:16px;box-shadow:var(--shadow);display:none;max-width:420px;z-index:99}.toast.show{display:block}.dangerText{color:var(--danger)}.okText{color:var(--ok)}@media(max-width:980px){.grid,.hero,.bigRound,.grid3{grid-template-columns:1fr;display:grid}.qr{grid-template-columns:1fr}.qr img{margin:auto}}
  </style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <div class="card main">
      <div class="eyebrow">INQUIRY & PRACTICE FINAL REPORT</div>
      <div class="title" id="titleText">探究與實作期末報告平台</div>
      <div class="sub">抽籤排序・QR 評分・報告 5 分鐘・提問 3 分鐘・評分換場 3 分鐘・Excel 匯出</div>
    </div>
    <div class="card" style="min-width:280px">
      <div class="muted">學生評分頁 QR Code</div>
      <div class="qr" style="grid-template-columns:1fr;margin-top:10px">
        <img id="qrImg" alt="學生評分 QR Code" />
      </div>
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h2>① 設定組別與抽籤排序</h2>
      <label class="label">活動名稱</label>
      <input id="titleInput" value="探究與實作期末報告" />
      <label class="label">組別名單（一行一組，也可用逗號分隔）</label>
      <textarea id="groupsInput">第1組
第2組
第3組
第4組
第5組
第6組
第7組
第8組</textarea>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" onclick="setupAndShuffle()">儲存組別並抽籤</button>
        <button class="btn ghost" onclick="reshuffle()">重新抽籤</button>
        <button class="btn ghost" onclick="copyStudentUrl()">複製學生網址</button>
      </div>
      <p class="muted">系統會檢查：同一順位的「報告組別」與「提問組別」不可相同；若衝突會自動重新排列或旋轉修正。</p>
    </section>

    <section class="card">
      <h2>② 目前輪次</h2>
      <div class="muted" id="roundInfo">尚未抽籤</div>
      <div class="bigRound" style="margin-top:12px">
        <div class="roleBox report"><div class="role">上台報告組別</div><div class="group" id="reportGroup">—</div></div>
        <div class="roleBox question"><div class="role">負責提問組別</div><div class="group" id="questionGroup">—</div></div>
      </div>
      <div class="phase" id="phaseLabel" style="margin-top:18px">設定中</div>
      <div class="timer" id="timer">00:00</div>
      <div class="progress"><div class="bar" id="bar"></div></div>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn primary" onclick="startPhase('report',300)">開始報告 5:00</button>
        <button class="btn" onclick="startPhase('question',180)">開始提問 3:00</button>
        <button class="btn warn" onclick="startPhase('rating',180)">評分／換場 3:00</button>
        <button class="btn ok" onclick="nextRound()">下一輪＋開始報告</button>
      </div>
    </section>
  </div>

  <div class="grid" style="margin-top:18px">
    <section class="card">
      <h2>③ 本輪即時評分結果</h2>
      <div class="grid3">
        <div><div class="muted">報告組平均</div><div class="score" id="reportAvg">—</div></div>
        <div><div class="muted">提問組平均</div><div class="score" id="questionAvg">—</div></div>
        <div><div class="muted">已評分／應評分</div><div class="score" id="scoreCount">—</div></div>
      </div>
      <p class="muted" id="missingGroups">未評分組別：—</p>
      <div class="row">
        <button class="btn primary" onclick="exportExcel()">匯出 Excel</button>
        <a class="btn ghost" href="/download.xlsx" target="_blank" style="text-decoration:none">下載 latest.xlsx</a>
      </div>
      <p class="muted" id="exportInfo">Excel 會存到本機 exports；若偵測到 Google Drive 同步資料夾，也會同步複製一份。</p>
    </section>

    <section class="card">
      <h2>④ 學生掃描資訊</h2>
      <div class="qr">
        <img id="qrImg2" alt="學生評分 QR Code" />
        <div>
          <div class="muted">學生網址</div>
          <div class="url" id="studentUrl">—</div>
          <p class="muted">手機必須和這台電腦在同一個 Wi‑Fi／區網。若 QR 無法掃，請直接輸入網址。</p>
        </div>
      </div>
    </section>
  </div>

  <section class="card" style="margin-top:18px">
    <h2>抽籤排序表</h2>
    <div style="overflow:auto;max-height:430px"><table id="orderTable"></table></div>
  </section>

  <section class="card" style="margin-top:18px">
    <h2>全部輪次分數總覽</h2>
    <div style="overflow:auto;max-height:430px"><table id="statsTable"></table></div>
  </section>

  <div class="footer">本平台資料儲存在老師電腦：Documents/探究與實作期末報告平台/data/state.json</div>
</div>
<div class="toast" id="toast"></div>
<script>
let STATE = null;
let lastTimerDoneKey = '';
function $(id){return document.getElementById(id)}
function toast(msg){const t=$('toast');t.innerHTML=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),4200)}
function mmss(sec){sec=Math.max(0,Math.floor(sec||0));const m=String(Math.floor(sec/60)).padStart(2,'0');const s=String(sec%60).padStart(2,'0');return `${m}:${s}`}
async function api(path, opts={}){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts}); if(!r.ok){throw new Error(await r.text())} return await r.json()}
function bell(){
  try{const ctx=new (window.AudioContext||window.webkitAudioContext)();
    [0,0.22,0.44].forEach((delay)=>{const osc=ctx.createOscillator();const gain=ctx.createGain();osc.type='sine';osc.frequency.value=880;gain.gain.setValueAtTime(0.0001,ctx.currentTime+delay);gain.gain.exponentialRampToValueAtTime(0.35,ctx.currentTime+delay+0.02);gain.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+delay+0.18);osc.connect(gain);gain.connect(ctx.destination);osc.start(ctx.currentTime+delay);osc.stop(ctx.currentTime+delay+0.2);});
  }catch(e){console.log(e)}
}
async function refresh(){
  try{STATE=await api('/api/state'); render(STATE)}catch(e){console.error(e)}
}
function render(st){
  $('titleText').textContent=st.title||'探究與實作期末報告平台'; $('titleInput').value=st.title||'';
  if((st.groups||[]).length && document.activeElement!==$('groupsInput')) $('groupsInput').value=(st.groups||[]).join('\n');
  const studentUrl=st.student_url_hint || (location.origin+'/student'); $('studentUrl').textContent=studentUrl;
  const qr='/qr?data='+encodeURIComponent(studentUrl)+'&t='+(st.updated_at||''); $('qrImg').src=qr; $('qrImg2').src=qr;
  const cr=st.current_round||{}; $('roundInfo').textContent=cr.total?`第 ${cr.round_no} / ${cr.total} 輪`:'尚未抽籤';
  $('reportGroup').textContent=cr.report_group||'—'; $('questionGroup').textContent=cr.question_group||'—';
  $('phaseLabel').textContent=(st.timer&&st.timer.phase_label)||st.phase_label||'設定中';
  const tm=st.timer||{}; $('timer').textContent=mmss(tm.remaining||0);
  const pct=tm.duration?Math.max(0,Math.min(100,100*(1-(tm.remaining||0)/tm.duration))):0; $('bar').style.width=pct+'%';
  const doneKey=(tm.phase||'')+':'+(tm.end_at||''); if(tm.running && tm.done && doneKey && doneKey!==lastTimerDoneKey){lastTimerDoneKey=doneKey; bell(); toast('⏰ 時間到！可以進入下一階段。')}
  const cs=st.current_stats||{}; $('reportAvg').textContent=cs.report_avg??'—'; $('questionAvg').textContent=cs.question_avg??'—'; $('scoreCount').textContent=(cs.count!=null)?`${cs.count}/${cs.expected_count}`:'—'; $('missingGroups').textContent='未評分組別：'+((cs.missing_groups||[]).join('、')||'—');
  renderOrders(st); renderStats(st);
}
function renderOrders(st){
  const ro=st.report_order||[], qo=st.question_order||[]; let html='<tr><th>順位</th><th>上台報告</th><th>負責提問</th><th>檢查</th></tr>';
  for(let i=0;i<Math.min(ro.length,qo.length);i++){const ok=ro[i]!==qo[i]; html+=`<tr class="${ok?'':'conflict'}"><td>${i+1}</td><td>${ro[i]}</td><td>${qo[i]}</td><td><span class="pill ${ok?'ok':'warn'}">${ok?'OK':'衝突'}</span></td></tr>`}
  $('orderTable').innerHTML=html;
}
function renderStats(st){
  let html='<tr><th>順位</th><th>報告組</th><th>提問組</th><th>報告平均</th><th>提問平均</th><th>評分進度</th><th>未評分</th></tr>';
  (st.stats||[]).forEach(s=>{html+=`<tr><td>${s.round_no}</td><td>${s.report_group}</td><td>${s.question_group}</td><td>${s.report_avg??'—'}</td><td>${s.question_avg??'—'}</td><td>${s.count}/${s.expected_count}</td><td>${(s.missing_groups||[]).join('、')||'—'}</td></tr>`});
  $('statsTable').innerHTML=html;
}
async function setupAndShuffle(){
  try{await api('/api/setup',{method:'POST',body:JSON.stringify({title:$('titleInput').value,groups:$('groupsInput').value})}); toast('已儲存組別並完成抽籤排序'); await refresh()}catch(e){toast('錯誤：'+e.message)}
}
async function reshuffle(){try{await api('/api/shuffle',{method:'POST',body:JSON.stringify({})}); toast('已重新抽籤'); await refresh()}catch(e){toast('錯誤：'+e.message)}}
async function startPhase(phase,duration){try{await api('/api/start_phase',{method:'POST',body:JSON.stringify({phase,duration})}); if(window.AudioContext||window.webkitAudioContext){ /* unlock audio */ bell(); setTimeout(()=>{},1); } await refresh()}catch(e){toast('錯誤：'+e.message)}}
async function nextRound(){try{await api('/api/next_round',{method:'POST',body:JSON.stringify({start_report:true})}); toast('已切換到下一輪並開始報告 5 分鐘'); await refresh()}catch(e){toast('錯誤：'+e.message)}}
async function exportExcel(){try{const r=await api('/api/export',{method:'POST',body:JSON.stringify({})}); $('exportInfo').innerHTML=`已匯出：<br><span class="okText">${r.path}</span>`+(r.drive_path?`<br>Google Drive：<span class="okText">${r.drive_path}</span>`:'<br><span class="dangerText">未偵測到 Google Drive 同步資料夾；已先存在本機。</span>'); toast('Excel 已匯出')}catch(e){toast('錯誤：'+e.message)}}
async function copyStudentUrl(){const url=location.origin+'/student'; try{await navigator.clipboard.writeText(url); toast('已複製學生網址')}catch(e){prompt('請複製學生網址',url)}}
refresh(); setInterval(refresh,1000);
</script>
</body>
</html>
"""

STUDENT_HTML = r"""
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>探究與實作期末報告評分</title>
  <style>
    :root{--bg:#07101d;--panel:#101d32;--ink:#f8fafc;--muted:#a7b2c6;--accent:#5eead4;--accent2:#60a5fa;--danger:#fb7185;--ok:#86efac;--line:rgba(255,255,255,.12)}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(160deg,#07101d,#102441);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif}.wrap{max-width:760px;margin:0 auto;padding:18px}.card{background:rgba(255,255,255,.07);border:1px solid var(--line);border-radius:24px;padding:18px;margin-bottom:14px;box-shadow:0 16px 40px rgba(0,0,0,.28)}h1{font-size:30px;line-height:1.12;margin:0 0 8px}.muted{color:var(--muted)}.round{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{border:1px solid var(--line);border-radius:18px;padding:15px;background:rgba(0,0,0,.18)}.role{color:var(--muted);font-weight:800}.group{font-size:28px;font-weight:950;margin-top:5px}select,textarea,input[type=range]{width:100%;font:inherit}select,textarea{background:#07101d;color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:12px}textarea{min-height:80px}.btn{border:none;border-radius:16px;padding:14px 16px;background:linear-gradient(135deg,#14b8a6,#2563eb);color:white;font-weight:950;font-size:18px;width:100%;cursor:pointer}.btn:disabled{opacity:.45;cursor:not-allowed}.scoreLine{display:grid;grid-template-columns:1fr 70px;gap:12px;align-items:center;margin:14px 0}.scoreVal{font-size:34px;font-weight:950;text-align:center;color:var(--accent)}.notice{padding:12px 14px;border-radius:14px;background:rgba(251,191,36,.14);border:1px solid rgba(251,191,36,.28)}.ok{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.28)}.danger{background:rgba(251,113,133,.14);border-color:rgba(251,113,133,.28)}@media(max-width:620px){.round{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="card"><h1 id="title">探究與實作期末報告評分</h1><div class="muted" id="phase">讀取中…</div></div>
  <div class="card">
    <div class="muted" id="roundInfo">—</div>
    <div class="round" style="margin-top:10px">
      <div class="box"><div class="role">上台報告組別</div><div class="group" id="reportGroup">—</div></div>
      <div class="box"><div class="role">負責提問組別</div><div class="group" id="questionGroup">—</div></div>
    </div>
  </div>
  <div class="card">
    <label class="role">你的組別</label>
    <select id="scorer" onchange="renderEligibility()"></select>
    <div id="eligibility" style="margin-top:12px"></div>
  </div>
  <form class="card" id="scoreForm" onsubmit="submitScore(event)">
    <div class="role">報告組整體表現分數（1–10）</div>
    <div class="muted">可參考：內容正確、探究歷程、證據品質、表達清楚、時間掌握。</div>
    <div class="scoreLine"><input id="reportScore" type="range" min="1" max="10" value="8" oninput="$('reportVal').textContent=this.value"><div class="scoreVal" id="reportVal">8</div></div>
    <div class="role">提問組問題品質分數（1–10）</div>
    <div class="muted">可參考：問題是否針對報告、是否促進思考、是否清楚、有沒有追問價值。</div>
    <div class="scoreLine"><input id="questionScore" type="range" min="1" max="10" value="8" oninput="$('questionVal').textContent=this.value"><div class="scoreVal" id="questionVal">8</div></div>
    <label class="role">備註，可不填</label>
    <textarea id="comment" placeholder="例如：提問很具體、報告圖表清楚、實驗變因還可再說明……"></textarea>
    <div style="height:12px"></div>
    <button class="btn" id="submitBtn" type="submit">送出／更新本輪評分</button>
  </form>
  <div class="card"><div class="muted">提醒：上台報告組與負責提問組本輪不需評分；其他組請在 3 分鐘評分／換場時間內完成。</div></div>
</div>
<script>
let STATE=null; function $(id){return document.getElementById(id)}
async function api(path,opts={}){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts}); if(!r.ok) throw new Error(await r.text()); return await r.json()}
function mmss(sec){sec=Math.max(0,Math.floor(sec||0));return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`}
async function refresh(){try{STATE=await api('/api/state'); render()}catch(e){console.error(e)}}
function render(){const st=STATE, cr=st.current_round||{}; $('title').textContent=(st.title||'探究與實作期末報告')+'｜評分'; $('phase').textContent=`${st.phase_label||''}　剩餘 ${mmss((st.timer||{}).remaining||0)}`; $('roundInfo').textContent=cr.total?`第 ${cr.round_no} / ${cr.total} 輪`:'尚未開始'; $('reportGroup').textContent=cr.report_group||'—'; $('questionGroup').textContent=cr.question_group||'—';
  const old=$('scorer').value; $('scorer').innerHTML='<option value="">請選擇你的組別</option>'+(st.groups||[]).map(g=>`<option value="${g}">${g}</option>`).join(''); if(old) $('scorer').value=old; renderEligibility();}
function renderEligibility(){if(!STATE)return; const g=$('scorer').value, cr=STATE.current_round||{}; const div=$('eligibility'), form=$('scoreForm'), btn=$('submitBtn'); if(!g){div.className='notice';div.textContent='請先選擇你的組別。'; btn.disabled=true; return;} if(g===cr.report_group){div.className='notice danger';div.textContent='你們本輪是上台報告組，不需要評分。'; btn.disabled=true; return;} if(g===cr.question_group){div.className='notice danger';div.textContent='你們本輪是負責提問組，不需要評分。'; btn.disabled=true; return;} div.className='notice ok';div.textContent='你們本輪是聽講評分組，請評分報告組與提問組。'; btn.disabled=false;}
async function submitScore(ev){ev.preventDefault(); const cr=STATE.current_round||{}; const scorer=$('scorer').value; if(!scorer){alert('請選擇你的組別'); return;} try{await api('/api/score',{method:'POST',body:JSON.stringify({round_index:cr.index,scorer_group:scorer,report_score:Number($('reportScore').value),question_score:Number($('questionScore').value),comment:$('comment').value})}); alert('已送出／更新評分，謝謝！'); await refresh()}catch(e){alert('送出失敗：'+e.message)}}
refresh(); setInterval(refresh,2000);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "InquiryReportPlatform/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (now_iso(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str = "text/plain; charset=utf-8", headers: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, code: int = 200, ctype: str = "text/plain; charset=utf-8") -> None:
        self._send(code, text.encode("utf-8"), ctype)

    def send_json(self, obj: Any, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            if path == "/":
                self.send_text(TEACHER_HTML, ctype="text/html; charset=utf-8")
            elif path == "/student":
                self.send_text(STUDENT_HTML, ctype="text/html; charset=utf-8")
            elif path == "/api/state":
                self.send_json(public_state())
            elif path == "/qr":
                data = qs.get("data", [f"http://{lan_ip()}:{PORT}/student"])[0]
                self.send_qr(data)
            elif path == "/download.xlsx":
                st = load_state()
                rec = export_excel(st)
                data = pathlib.Path(rec["path"]).read_bytes()
                filename = pathlib.Path(rec["path"]).name
                self._send(200, data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {"Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}"})
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e), "trace": traceback.format_exc()}, 500)

    def do_POST(self) -> None:
        try:
            path = urllib.parse.urlparse(self.path).path
            body = self.read_json()
            st = load_state()
            if path == "/api/setup":
                groups = parse_groups(body.get("groups"))
                if len(groups) < 2:
                    self.send_json({"error": "至少需要 2 個組別，才能避免報告組與提問組同順位衝突。"}, 400)
                    return
                report, question = make_deranged_orders(groups)
                st.update({
                    "title": normalize_group_name(body.get("title") or st.get("title") or "探究與實作期末報告"),
                    "groups": groups,
                    "report_order": report,
                    "question_order": question,
                    "current_index": 0,
                    "phase": "setup",
                    "timer": {"running": False, "phase": "setup", "duration": 0, "start_at": None, "end_at": None},
                    "scores": {},
                })
                save_state(st)
                self.send_json(public_state(st))
            elif path == "/api/shuffle":
                groups = st.get("groups") or DEFAULT_GROUPS
                if len(groups) < 2:
                    self.send_json({"error": "至少需要 2 個組別。"}, 400)
                    return
                report, question = make_deranged_orders(groups)
                st["report_order"] = report
                st["question_order"] = question
                st["current_index"] = 0
                st["phase"] = "setup"
                st["timer"] = {"running": False, "phase": "setup", "duration": 0, "start_at": None, "end_at": None}
                st["scores"] = {}
                save_state(st)
                self.send_json(public_state(st))
            elif path == "/api/start_phase":
                phase = body.get("phase")
                duration = int(body.get("duration") or 0)
                if phase not in {"report", "question", "rating"}:
                    self.send_json({"error": "unknown phase"}, 400)
                    return
                if duration <= 0:
                    self.send_json({"error": "duration must be positive"}, 400)
                    return
                st = start_timer(st, phase, duration)
                self.send_json(public_state(st))
            elif path == "/api/next_round":
                total = current_round(st)["total"]
                if total <= 0:
                    self.send_json({"error": "尚未抽籤。"}, 400)
                    return
                idx = int(st.get("current_index") or 0)
                if idx >= total - 1:
                    st["phase"] = "done"
                    st["timer"] = {"running": False, "phase": "done", "duration": 0, "start_at": None, "end_at": None}
                    save_state(st)
                    self.send_json(public_state(st))
                    return
                st["current_index"] = idx + 1
                if body.get("start_report", True):
                    st = start_timer(st, "report", 300)
                else:
                    st["phase"] = "setup"
                    st["timer"] = {"running": False, "phase": "setup", "duration": 0, "start_at": None, "end_at": None}
                    save_state(st)
                self.send_json(public_state(st))
            elif path == "/api/score":
                idx = int(body.get("round_index", current_round(st)["index"]))
                total = current_round(st)["total"]
                if idx < 0 or idx >= total:
                    self.send_json({"error": "round_index out of range"}, 400)
                    return
                scorer = normalize_group_name(body.get("scorer_group"))
                if scorer not in (st.get("groups") or []):
                    self.send_json({"error": "請選擇有效組別。"}, 400)
                    return
                report = st["report_order"][idx]
                question = st["question_order"][idx]
                if scorer in {report, question}:
                    self.send_json({"error": "本輪報告組與提問組不需要評分。"}, 400)
                    return
                report_score = float(body.get("report_score"))
                question_score = float(body.get("question_score"))
                if not (1 <= report_score <= 10 and 1 <= question_score <= 10):
                    self.send_json({"error": "分數必須是 1–10。"}, 400)
                    return
                st.setdefault("scores", {}).setdefault(str(idx), {})[scorer] = {
                    "report_score": report_score,
                    "question_score": question_score,
                    "comment": normalize_group_name(body.get("comment") or ""),
                    "submitted_at": now_iso(),
                }
                save_state(st)
                self.send_json({"ok": True, "state": public_state(st)})
            elif path == "/api/export":
                rec = export_excel(st)
                self.send_json(rec)
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e), "trace": traceback.format_exc()}, 500)

    def send_qr(self, data: str) -> None:
        try:
            import qrcode  # type: ignore
            img = qrcode.make(data)
            bio = io.BytesIO()
            img.save(bio, format="PNG")
            self._send(200, bio.getvalue(), "image/png")
            return
        except Exception:
            # Fallback SVG: visible URL; teacher can still show/copy the link.
            text = html.escape(data)
            svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 420 420">
<rect width="420" height="420" fill="white"/><rect x="18" y="18" width="384" height="384" rx="20" fill="#f1f5f9" stroke="#0f172a" stroke-width="4"/>
<text x="210" y="120" text-anchor="middle" font-size="30" font-family="Arial, sans-serif" font-weight="700" fill="#0f172a">QR 模組未載入</text>
<text x="210" y="170" text-anchor="middle" font-size="20" font-family="Arial, sans-serif" fill="#334155">請直接輸入學生網址</text>
<foreignObject x="40" y="205" width="340" height="130"><div xmlns="http://www.w3.org/1999/xhtml" style="font:18px Arial;word-break:break-all;text-align:center;color:#0f172a">{text}</div></foreignObject>
</svg>'''
            self._send(200, svg.encode("utf-8"), "image/svg+xml")


def main() -> None:
    # Ensure state exists and has a valid deranged default order for immediate use.
    st = load_state()
    if not st.get("report_order") or not st.get("question_order"):
        report, question = make_deranged_orders(st.get("groups") or DEFAULT_GROUPS)
        st["report_order"] = report
        st["question_order"] = question
        save_state(st)
    ip = lan_ip()
    print("=" * 72)
    print("探究與實作期末報告平台已啟動")
    print(f"老師端：http://{ip}:{PORT}/")
    print(f"學生端：http://{ip}:{PORT}/student")
    print(f"本機資料：{DATA_DIR}")
    print(f"Excel 輸出：{EXPORT_DIR}")
    drive = find_drive_dir()
    print(f"Google Drive 同步資料夾：{drive if drive else '未偵測到'}")
    print("=" * 72)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
