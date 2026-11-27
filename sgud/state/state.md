# 狀態

本檔為當前已開發功能之最新狀態(現況),接續工作時先讀此檔.只記現況,過程寫入`sgud/exp/experience.md`;規則(藍圖)見`sgud/rule/rulebook.md`.

## 功能與狀態

| 功能 | 狀態 | 規則帳本 | 測試檔 |
|---|---|---|---|
| `downloadTrades`(依時刻分頁、以編號去重、半開區間) | 已完成 | R3 | `api-download`(D1、D2、D2b) |
| `saveTrades`(逐UTC日存檔、續傳、寬限、失敗與停止) | 已完成 | R2、R5 | `api-download`(D3~D7) |
| `readTrades`、`summarizeRange`(自每日檔以使用端之日界取用) | 已完成 | R2、R9 | `api-download`(D3、D4) |
| `parseInstrument`、`aggregateTrades`、`summarizeCells`(格與13個基本量) | 已完成 | R9 | `unit-aggregate`(A1~A6) |
| `downloadVolIndex`、`saveVolIndex`(`continuation`續頁、去重、CSV;區間半開 `[tStart, tEnd)`) | 已完成 | R10、R13 | `api-download`(D8、D10) |
| 區間語意統一為半開 `[tStart, tEnd)`(成交之下載與讀取、彙整、波動指數之下載與存檔) | 已完成(2026-11-27 複審後,波動指數由含兩端改半開) | R13 | `api-download`(D1、D3、D8) |
| 請求端(節流、逾時、重試與分類、代理) | 已完成 | R4、R6 | `api-request`(Q1~Q5、Q8~Q11) |
| `opt.onTrace`(`throttle`、`attempt`、`retry`、`day`、`halt`) | 已完成 | R7 | `api-request`(Q2~Q8)、`api-download`(D3、D5、D7) |
| 選項之檢測(`getOptReader`;必須參數、口徑、來源與出口之選項拋,其餘改用預設) | 已完成 | R8 | `unit-aggregate`(A4)、`api-request`(Q6)、`api-download`(D2、D6、D8、D9) |
| 發布與建置(`toolg/`、`dist/` 為 Node 端 UMD) | 已完成(於套件副本驗過 `script.txt` 各列;`dist/`、`docs/` 於發布時產製) | R12 | — |
| 變異驗證工具(`test/tools/mutants.mjs`) | 已完成;84項皆殺死(見〈最近一次驗證〉) | R11 | 手動執行(`node test/tools/mutants.mjs --out ./tmp/mut`) |

## 已知缺口與待辦

- 無已知缺口.未納入之範圍見規則帳本 R1(定時同步、當下之鏈快照、幣安、因子之計算).
- 未發布:版本 1.0.0,GitHub 之 repo 尚未建立,未推送.
- 波動指數 `downloadVolIndex`/`saveVolIndex` 只經本機假伺服器驗過,未實連核對(實連核對只做逐筆成交之兩日).

## 最近一次驗證

- 2026-11-27:`npm test` 28案全綠(`unit-aggregate` 6、`api-request` 11、`api-download` 11);eslint 0;jsdoc 無 ERROR;變異 84 項全部殺死(首輪 82 項存活 7 項,皆為測試缺口,補案後 0 存活,見經驗).
- 實連(手動,只送公開查詢參數;ETH 選擇權,2024-02-29、2024-03-01 兩個 UTC 日):19,030 與 14,503 筆(各 2 頁,共 4 次請求,約 11 秒),gzip 後 0.34 與 0.25 MB;取台北 2024-03-01 = `[02-29T16:00Z, 03-01T16:00Z)` 彙整:入格 17,737 筆、略過 0、格 214 個(`'std'` 口徑:入格 17,711 筆、略過 26、格 219 個).
