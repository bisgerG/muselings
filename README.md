# Muselings 博物之靈 — 時空守護者（MVP 技術驗證版）

純前端 WebAR 互動圖鑑收集遊戲的骨架。零後端、零建置工具，可直接部署至 GitHub Pages。

驗證目標：跑通完整核心迴圈 —— **掃描 Marker → 精靈登場 → 對話 → 撫摸互動 → 科普知識 → 答題收服 → 記錄圖鑑（localStorage）**。

## 技術棧

| 項目 | 方案 |
|---|---|
| WebAR | [MindAR.js](https://hiukim.github.io/mind-ar-js-doc/) Image Tracking（CDN 載入） |
| 3D 場景 | A-Frame 1.5.0（CDN 載入） |
| 精靈模型 | MVP 用 A-Frame 幾何體組裝，之後可整組換成 `<a-gltf-model>` |
| Marker | 暫用 MindAR 官方範例的預編譯 `.mind` 檔（已下載至 `assets/targets/`） |
| 存檔 | localStorage（`js/save.js`，帶 schema 版本、無痕模式降級） |

## 本機測試

相機需要 secure context（HTTPS 或 localhost）：

```bash
# 任選一種，在專案根目錄啟動靜態伺服器
python -m http.server 8000
# 或
npx http-server -p 8000
```

1. 電腦瀏覽器開 `http://localhost:8000`（用電腦的 webcam 測）。
2. 用手機（或另開視窗）打開 `marker.html` 顯示測試圖案，或把圖案列印出來。
3. 點「開始任務」→ 允許相機 → 鏡頭對準圖案 → 小快登場。
4. 完整流程走完後，到「我的圖鑑」確認收錄與重新整理後進度保留。

> 手機實測：手機上 `localhost` 不可用，直接推上 GitHub Pages（見下方）用 HTTPS 網址測最快。

## 部署到 GitHub Pages

```bash
git init && git add -A && git commit -m "MVP skeleton"
gh repo create muselings --public --source . --push
gh api repos/<user>/muselings/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

或在 GitHub 網頁：Settings → Pages → Branch 選 `main` / root。

## 換成自製 Marker（正式版）

1. 設計高對比、紋理豐富、不對稱的「裂縫圖騰」圖案。
2. 用 [MindAR 線上編譯器](https://hiukim.github.io/mind-ar-js-doc/tools/compile) 把圖案編譯成 `.mind` 檔。
3. 放到 `assets/targets/`，並修改 `ar.html` 中 `mindar-image` 的 `imageTargetSrc` 路徑。

## 目錄結構

```
├── index.html              # 入口：劇情 + 測試須知
├── ar.html                 # AR 場景（恐龍廳）+ UI 疊層
├── dex.html                # 互動圖鑑（讀 localStorage）
├── marker.html             # 測試用 Marker 顯示頁
├── css/style.css
├── js/
│   ├── save.js             # 存檔模組（localStorage + 降級）
│   └── ar-game.js          # 核心迴圈狀態機
├── assets/targets/
│   ├── demo.mind           # 預編譯追蹤檔（正式版換成自製圖騰的 .mind）
│   └── demo-marker.png     # 測試用 Marker 圖案
└── data/scripts/
    └── raptor_kid.json     # 小快的對話腳本與題庫（策展人可直接編修）
```

## 驗證清單

- [ ] iPhone Safari：相機授權、Marker 3 秒內辨識、模型穩定疊加
- [ ] Android Chrome：同上
- [ ] 點擊精靈有反應（撫摸動畫 + 好感度愛心）
- [ ] 答錯有提示、答對有收服演出
- [ ] 重新整理 / 關閉重開後，圖鑑進度仍在
- [ ] 中階手機發熱與流暢度可接受

## 已知限制（MVP 刻意簡化）

- Marker 為官方範例圖，正式版需換自製圖騰。
- 精靈為幾何體組裝，無骨骼動畫；Phase 2 換 Draco 壓縮的 GLB。
- 尚無音效、PWA 離線快取、多展區與道具系統（依開發計畫 Phase 2~3 補上）。
