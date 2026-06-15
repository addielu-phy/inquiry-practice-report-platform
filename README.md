# 探究與實作期末報告平台

穩定網站版：抽籤排序、QR 即時評分、座號紀錄、三向度報告評量、報告／提問／換場計時、平均分數與 Excel 匯出。

## 正式網址

- 公開網站：<https://addielu-phy.github.io/inquiry-practice-report-platform/>
- 原始碼：<https://github.com/addielu-phy/inquiry-practice-report-platform>

## 公開網站版特色

- 老師端在 GitHub Pages 上直接開啟，不需要安裝。
- 可依不同班級設定組數，例如 8 組、9 組、12 組；也可手動修改特殊組名。
- 老師按「建立即時收分 Session」後，系統產生學生 QR Code。
- 學生掃 QR 後填寫自己的組別與座號；分數透過 PeerJS/WebRTC 即時送回老師端。
- 報告組分數分成三個探究與實作關鍵能力：
  1. **探究問題與方法設計**：問題意識、變因控制、方法合理性。
  2. **資料證據與分析解釋**：數據品質、圖表呈現、證據支持結論。
  3. **科學表達與回應能力**：結構清楚、時間掌握、回應提問。
- 提問組維持「問題品質分數」1–10 分。
- 老師端可顯示本輪報告組、提問組、倒數計時、三向度平均、報告總平均、提問平均與未評分組別。
- 活動結束可下載 `.xlsx` Excel 檔與 JSON 備份。

## 使用流程

1. 老師開啟公開網址。
2. 確認活動名稱。
3. 在「組數快速設定」輸入班級組數，例如 `9`，按「套用組數」。
4. 若有特殊組名，在組別名單中逐行修改。
5. 按「儲存並抽籤」。
6. 按「建立即時收分 Session」。
7. 投影 QR Code 給學生掃。
8. 學生填寫：
   - 自己的組別
   - 自己的座號
   - 報告組三項能力分數
   - 提問組問題品質分數
9. 每輪依序按：
   - 開始報告 5:00
   - 開始提問 3:00
   - 評分／換場 3:00
   - 下一輪＋開始報告
10. 活動結束下載 Excel 與 JSON 備份。

## Excel 欄位

Excel 會包含：

- 總表：每輪報告總平均、三向度平均、提問平均、評分人數、已評分組數、未評分組別。
- 組別總結：各組作為報告組與提問組時的平均表現。
- 原始評分：每一筆學生送出的評分，包含評分組別與座號。
- 抽籤排序：每輪報告組與提問組排序。

## 重要限制

公開網站版使用 P2P 即時連線：

- 老師端分頁必須保持開啟。
- 評分資料存在老師瀏覽器 localStorage；請活動結束務必下載 Excel / JSON。
- 若同一組同一座號重複送出，會視為「更新自己的評分」。
- 若學校網路阻擋 WebRTC 或 CDN，改用 `local-server/` 裡的本機 LAN 版。
- 公開網站版不會自動寫入 Google Drive；瀏覽器會下載 Excel。若要自動寫入 Drive，使用本機 LAN 版或後續接 Firebase / Google Apps Script。

## 本機 LAN 備援版

當公開網站版連線不穩，或需要自動輸出到 Google Drive for desktop 時，可用本機版。注意：本機 LAN 版保留原始課堂備援流程；若要與公開網站版完全同規格，需另行同步更新 `local-server/server.py`。

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
