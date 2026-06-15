# 探究與實作期末報告平台

穩定網站版：抽籤排序、QR 即時評分、報告／提問／換場計時、平均分數與 Excel 匯出。

## 公開網站版特色

- 老師端在 GitHub Pages 上直接開啟，不需要安裝。
- 老師按「建立即時收分 Session」後，系統產生學生 QR Code。
- 學生掃 QR 後用手機評分；分數透過 PeerJS/WebRTC 即時送回老師端。
- 老師端可顯示本輪報告組、提問組、倒數計時、平均分數與未評分組別。
- 活動結束可下載 `.xlsx` Excel 檔與 JSON 備份。

## 使用流程

1. 老師開啟公開網址。
2. 確認活動名稱與組別名單。
3. 按「儲存並抽籤」。
4. 按「建立即時收分 Session」。
5. 投影 QR Code 給學生掃。
6. 每輪依序按：
   - 開始報告 5:00
   - 開始提問 3:00
   - 評分／換場 3:00
   - 下一輪＋開始報告
7. 活動結束下載 Excel 與 JSON 備份。

## 重要限制

公開網站版使用 P2P 即時連線：

- 老師端分頁必須保持開啟。
- 評分資料存在老師瀏覽器 localStorage；請活動結束務必下載 Excel / JSON。
- 若學校網路阻擋 WebRTC 或 CDN，改用 `local-server/` 裡的本機 LAN 版。
- 公開網站版不會自動寫入 Google Drive；瀏覽器會下載 Excel。若要自動寫入 Drive，使用本機 LAN 版或後續接 Firebase / Google Apps Script。

## 本機 LAN 備援版

當公開網站版連線不穩，或需要自動輸出到 Google Drive for desktop 時，可用本機版：

```bash
PYTHONUNBUFFERED=1 uv run --with 'qrcode[pil]' python local-server/server.py
```

本機版會顯示：

- 老師端：`http://<LAN_IP>:8765/`
- 學生端：`http://<LAN_IP>:8765/student`

學生需與老師電腦在同一個 Wi-Fi / LAN。

## 開發與調整

本網站是純靜態檔案：

- `index.html`：頁面結構
- `src/styles.css`：版面與視覺
- `src/app.js`：抽籤、PeerJS 即時收分、計時與 Excel 匯出邏輯
- `local-server/server.py`：本機 LAN 備援版

檢查 JavaScript 語法：

```bash
node --check src/app.js
```

本機預覽：

```bash
python -m http.server 8080
```

然後打開：

```text
http://127.0.0.1:8080/
```
