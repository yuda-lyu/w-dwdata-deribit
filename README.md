# w-dwdata-deribit
A download tool for Deribit public market data (no API key needed): per-day files of option trades, cells and daily summary quantities aggregated from the trades, and the volatility index.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-dwdata-deribit.svg?style=flat)](https://npmjs.org/package/w-dwdata-deribit) 
[![license](https://img.shields.io/npm/l/w-dwdata-deribit.svg?style=flat)](https://npmjs.org/package/w-dwdata-deribit) 
[![npm download](https://img.shields.io/npm/dt/w-dwdata-deribit.svg)](https://npmjs.org/package/w-dwdata-deribit) 
[![npm download](https://img.shields.io/npm/dm/w-dwdata-deribit.svg)](https://npmjs.org/package/w-dwdata-deribit) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-dwdata-deribit.svg)](https://www.jsdelivr.com/package/npm/w-dwdata-deribit)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-dwdata-deribit/global.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-dwdata-deribit
```

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-dwdata-deribit/blob/master/g-ETH.mjs)]
```alias
import WDwdataDeribit from 'w-dwdata-deribit'

async function test() {

    //wdd
    let wdd = WDwdataDeribit()

    //下載ETH選擇權之逐筆成交至每日檔(UTC日, 已有檔之日不重抓)
    let r = await wdd.saveTrades('ETH', 'option', './data/ETH/option', '2024-02-29', { dayEnd: '2024-03-01' })
    console.log(r.saved.map((v) => [v.day, v.n]))

    //以使用端之日界取用(此例為台北2024-03-01 = [02-29T16:00Z, 03-01T16:00Z)): 讀檔 → 格 → 每日基本量
    let tStart = Date.parse('2024-02-29T16:00:00Z')
    let s = wdd.summarizeRange('./data/ETH/option', tStart, tStart + 86400000)
    console.log(s.complete, s.n, s.summary.pcr)

}
test()
```

## Functions

`WDwdataDeribit(opt)` 回傳下列函式與 `stats`(累計送出之請求數 `{ requests }`)。非同步者回傳 Promise(必須參數無效時 reject，先於任何連網與寫檔)；同步者無效時拋錯。所有錯誤訊息為 `invalid <名稱>: must be <種類>` 之固定詞彙，不帶輸入值、網址與路徑。

| 函式 | 作用 |
|---|---|
| `downloadTrades(currency, kind, tStart, tEnd, opt)` | 下載區間內之全部成交：依時刻遞增分頁，下一頁自本頁末筆之時刻起(含)並以 `trade_id` 去重；整頁皆已見過而該頁已達單頁上限(同一毫秒之筆數不小於 `opt.count`)即無從以時刻續頁，拋錯(`kind: 'pagingLimit'`)。回 `{ trades, pages }` |
| `saveTrades(currency, kind, fdTrades, dayStart, opt)` | 逐 UTC 日下載並存檔；已有檔之日不重抓(不送請求)；只處理日終 + `opt.timeGrace`(預設 10 分鐘)不晚於現在之日。回 `{ days, saved, skipped, failed, halted }` |
| `readTrades(fdTrades, tStart, tEnd)` | 自每日檔讀區間內之成交(可跨日)，另回尚無檔之 UTC 日 `missingDays`。回 `{ trades, missingDays }` |
| `aggregateTrades(trades, opt)` | 逐筆 → 格(買賣權 × 主動買賣 × 價性 9 級 × 距到期日數 8 級)。回 `{ n, skipped, cells }` |
| `summarizeCells(cells)` | 格 → 每日基本量 13 個(見下)；分母為 0 者為 `NaN` |
| `summarizeRange(fdTrades, tStart, tEnd, opt)` | 以使用端之日界取用：讀檔 → 格 → 基本量；範圍內有尚未下載之日者 `complete: false`。回 `{ complete, missingDays, n, skipped, cells, summary }` |
| `parseInstrument(name)` | 解析選擇權合約名(如 `ETH-9JUN23-1850-P`；履約價之小數點可為 `d`)，回 `{ base, expiry, strike, type }`，不合者 `null` |
| `downloadVolIndex(currency, tStart, tEnd, opt)` | 下載區間內之隱含波動指數(DVOL)：依回應之 `continuation` 往前續頁、依時刻去重、遞增排序、範圍外之點濾除。回 `[[時刻, 開, 高, 低, 收], …]` |
| `saveVolIndex(currency, fp, tStart, tEnd, opt)` | 同上並存成單一 CSV(欄 `ts,open,high,low,close`；先寫暫存檔再改名；整檔重寫)。回 `{ n, from, to }` |

- `currency`：幣別(如 `'ETH'`、`'BTC'`)；`kind`：種類(如 `'option'`)；`tStart`、`tEnd`：毫秒時間戳(數字或數字字串)，區間語意見〈Time ranges〉；`fdTrades`：每日檔之資料夾；`dayStart`、`opt.dayEnd`：UTC 日 `'YYYY-MM-DD'`(日為單位，`opt.dayEnd` 含該日)。
- 逐筆成交走歷史主機(`opt.hostHistory`，預設 `https://history.deribit.com`；涵蓋全部期間，含最近 2 小時；即時主機只有近期)，波動指數走即時主機(`opt.hostLive`，預設 `https://www.deribit.com`；歷史主機無此端點，ETH 自 2021-03-24 起)。
- 並行呼叫同一下載器之 `saveTrades`(例如對不同日期範圍)共用同一個節流，總請求速率不變。

### Time ranges

所有以毫秒時間戳 `tStart`、`tEnd` 給區間之函式(`downloadTrades`、`readTrades`、`summarizeRange`、`downloadVolIndex`、`saveVolIndex`)一律為**半開區間 `[tStart, tEnd)`**：恰在 `tStart` 之資料入，恰在 `tEnd` 之資料不入；`tEnd` 須大於 `tStart`。故以相同之日界呼叫任兩個函式不會在邊界重複，相鄰兩區間 `[a, b)` 與 `[b, c)` 之結果相接，不重複、不遺漏(例：使用端以台北日界取每日之成交與波動指數，每日各取 `[當日 00:00, 次日 00:00)`)。波動指數之請求仍以 `tEnd` 為交易所之迄(其迄為含)，恰在 `tEnd` 之點於本端濾除。`saveTrades` 之 `dayStart`、`opt.dayEnd` 以 UTC 日為單位(含 `opt.dayEnd` 該日)，不屬時間戳區間。

### 建立下載器之選項(`WDwdataDeribit(opt)`)

| 選項 | 預設 | 說明 |
|---|---|---|
| `hostHistory`、`hostLive` | 見上 | 決定下載來源：須為 http(s) 網址且不帶帳密、查詢與片段；給了而無效即拋，不改用預設 |
| `proxy` | 無 | 代理，axios 之 `{ protocol, host, port, auth }` 格式；決定網路出口：給了而無效即拋(改用預設會使請求不經代理直連)；未給則依 axios 之預設(含環境變數 `HTTP_PROXY` 等) |
| `minGapMs` | 220 | 相鄰兩次請求之起始最小間隔(毫秒) |
| `retryTimes` | 3 | 請求失敗後之重試次數，0 為不重試 |
| `timeRetry` | 1000 | 第 i 次重試前等待 `timeRetry × 3^(i−1)` 毫秒(預設 1、3、9 秒) |
| `timeRetryMax` | 60000 | 每次等待之上限(毫秒) |
| `timeRequest` | 60000 | 單一請求自送出至收完回應之逾時(毫秒) |
| `onTrace` | 無 | 觀察回調，見〈onTrace〉 |
| `debug`、`funLog` | `false`、`console.warn` | `debug: true` 時，非預期之選項改用預設會輸出警告(固定詞彙，不含輸入值)，由 `funLog(msg, { fn, reason, key })` 輸出 |

### 各函式之選項(`opt`)

| 函式 | 選項 | 預設 | 說明 |
|---|---|---|---|
| `downloadTrades`、`saveTrades` | `count` | 10000 | 單頁筆數(1 ~ 10000，交易所上限 10000)，給了而無效改用預設 |
| `saveTrades` | `dayEnd` | 最近一個已完整之日 | 迄日(含，UTC)；決定下載範圍：給了而無效即拋；超過最近一個已完整之日者以後者為準 |
| `saveTrades` | `timeGrace` | 600000 | 日終後之寬限(毫秒)，給了而無效改用預設 |
| `saveTrades` | `netFailTimes` | 3 | 連續此數之日皆為連線層失敗時停止本次執行之後續請求，0 為不停止 |
| `aggregateTrades`、`summarizeRange` | `moneyness` | `'pct'` | 價性之口徑：`'pct'` = ln(履約價 ÷ 指數價) 之固定界；`'std'` = 再除以該筆之隱含波動率 × √距到期年數(同一級於高低波動時代表相近之價外程度，無正之隱含波動率者不入格) |
| 同上 | `priceInCoin` | `true` | 權利金之報價是否以標的幣計：`true` ⇒ 權利金(美元) = 價 × 指數價 × 口數；`false` ⇒ 價 × 口數 |
| 同上 | `minDte` | `1/24` | `'std'` 之距到期日數下限(避免到期前一刻之值發散) |
| `downloadVolIndex`、`saveVolIndex` | `resolution` | `3600` | 解析度：秒數(正整數，如 1、60、3600、43200)或 `'1D'`；交易所不支援之值由其回 400 |

選項之檢測依「輸入參數之檢測機制」：必須參數(位置參數)無效即拋(Promise 者 reject)；`undefined` 與 `null` 視為未給；影響資料口徑(`moneyness`、`priceInCoin`、`minDte`、`resolution`)、下載來源與範圍(`hostHistory`、`hostLive`、`dayEnd`)與網路出口(`proxy`)之選項給了而無效即拋，不改用預設；其餘執行參數(重試、逾時、節流、寬限、單頁筆數)給了而無效改用預設，整數類接受數字字串並轉為數值。

## Storage layout

逐筆成交以 **UTC 日**分檔(與使用端之日界、時區無關，換日界或時區不必重抓)：

```
<fdTrades>/<YYYY>/<YYYY-MM-DD>.csv.gz
```

- 內容為 gzip 壓縮之 CSV，欄 `ts,id,name,dir,amount,price,iv,index,mark`(成交毫秒時間戳、成交編號、合約名、主動方 `buy`/`sell`、口數、價、隱含波動率、指數價、標記價；無值之欄為空字串)。
- **檔存在 = 該日已完整下載**：先寫暫存檔(`<檔名>.<pid>.<序號>.tmp`)再改名；0 筆之日照樣寫出只有欄名之檔(依時刻查成交時「空」是有效之回答，不標註為無數據)。要重抓某日，刪除該日之檔。
- 損毀之每日檔(欄名不符、欄數不符、無法解壓)於 `readTrades` 時拋錯，不靜默略過。
- 波動指數為單一 CSV(欄 `ts,open,high,low,close`)，路徑由使用端指定。

## Retry, failure and stop

抓與用分開：本套件只負責抓與重試；請求失敗不算缺數據、不標註、不寫檔，下次執行再抓。

- **重試**：每次請求失敗時重試 `retryTimes` 次，第 i 次前等待 `timeRetry × 3^(i−1)` 毫秒(不超過 `timeRetryMax`)。重試之情形：連線錯誤(`network`)、逾時(`timeout`)、HTTP 5xx(含 503 維護 `maintenance`)、HTTP 429 或錯誤代碼 10028(流量限制 `rateLimited`，HTTP 200 而帶此代碼者亦同)、HTTP 2xx 而回應無 `result`(`invalidResponse`，如代理之 HTML 頁面)；400(`badRequest`)與其餘 4xx、3xx 不重試(轉址不跟隨)。請求成功時不多送請求、不多等待。
- **失敗物件**：重試用盡後 reject 之 `Error` 帶 `kind`、`httpStatus`、`code`(回應內之錯誤代碼，無則 `null`)、`attempts`；訊息為 `request failed: kind[…] status[…] attempts[…]`，不帶網址與參數。
- **`saveTrades` 之失敗與停止**：請求失敗之日不寫檔，列入 `failed: [{ day, kind, httpStatus, attempts }]`。停止本次執行之後續請求(續送會白等或延長限制)：維護(503)或流量限制用盡重試；連續 `netFailTimes` 日皆為連線層失敗(`network`、`timeout`；中間有成功之日者歸零)。`halted` 為停止之原因(`'maintenance'`、`'rateLimited'`、`'network'`，未停止為 `null`)，未送之日列入 `failed`(`kind: 'notRequested'`、`attempts: 0`)。5xx 用盡、回應格式不符、單頁上限(`pagingLimit`)之日只列入 `failed`，不停止。
- **檔案寫入之錯誤**(磁碟已滿、無權限等)不屬請求失敗，`saveTrades` 直接 reject。

## Throttle

相鄰兩次請求之**起始**至少相隔 `minGapMs`(預設 220 毫秒；以單調時鐘計，不受系統時間被往回撥之影響)。同一下載器之並行呼叫共用此節流。重試之等待另計。

## onTrace

`opt.onTrace(e)`：同步呼叫、`e` 為凍結之 `{ type, … }`、拋錯與回傳之 rejection 皆忽略、未給時不組事件(零額外成本)。供以事件而非延時核對重試、節流與逐日處理：

| `type` | 欄位 | 時機 |
|---|---|---|
| `throttle` | `wait` | 因節流而等待(毫秒) |
| `attempt` | `attempt`、`kind`、`httpStatus` | 每次請求後；`kind` 為 `ok`、`invalidResponse`、`rateLimited`、`maintenance`、`badRequest`、`httpError`、`timeout`、`network` |
| `retry` | `attempt`、`wait`、`kind` | 重試前之等待(毫秒) |
| `day` | `day`、`state`、`n`、`kind` | `saveTrades` 處理完一日；`state` 為 `skipped`、`saved`、`failed`、`notRequested` |
| `halt` | `day`、`reason` | `saveTrades` 停止本次執行之後續請求 |

## Cells and daily summary quantities

`aggregateTrades` 之格之鍵為 `${C|P}${B|S}|${價性級}|${日數級}`(C 買權、P 賣權；B 主動買、S 主動賣)，值為 `[口數, 權利金, Σ(隱含波動率 × 口數), 有隱含波動率之口數, 筆數]`。無從歸格者(合約名不合、指數價或口數非正、已過到期、主動方不明；`'std'` 另須有正之隱含波動率)計入 `skipped`。

- 價性級(`'pct'`，ln(履約價 ÷ 指數價))：`< −20%`、`−20 ~ −10%`、`−10 ~ −5%`、`−5 ~ −2%`、`±2%` 內、`2 ~ 5%`、`5 ~ 10%`、`10 ~ 20%`、`≥ 20%`(級 0 ~ 8，恰在界上歸較高之級)；`'std'` 之界為 `−2、−1、−0.5、−0.2、0.2、0.5、1、2`。
- 日數級(距到期日數)：`< 1`、`1 ~ 3`、`3 ~ 7`、`7 ~ 14`、`14 ~ 30`、`30 ~ 60`、`60 ~ 120`、`≥ 120`(級 0 ~ 7)；到期日為 08:00 UTC。

`summarizeCells` 之基本量：`total` 總口數；`pcr` 賣權口數比；`pcrPrem` 賣權權利金比；`netCall`、`netPut` 買權、賣權之主動買賣差 ÷ 其口數；`bullFlow`(買權淨買 − 賣權淨買)÷ 總口數，`bullFlowPrem` 其權利金版；`skew` 價外賣權(價性級 1、2)− 價外買權(級 6、7)之隱含波動率(日數級 3 ~ 5)；`atmIv` 價平(價性級 3 ~ 5；日數級 3 ~ 5)之隱含波動率；`term` 短(日數級 1、2)− 長(日數級 5、6)之價平隱含波動率；`shortShare` 日數級 ≤ 1 之口數占比；`otmCallShare` 買權價性級 ≥ 6 之占比；`otmPutShare` 賣權價性級 ≤ 2 之占比。隱含波動率為各格以口數加權之平均(只計有隱含波動率之口數)。

## Not included

- 定時同步(使用端以排程呼叫 `saveTrades`；已有檔之日不重抓，故每日補一日即可)。
- 當下之鏈快照(未平倉量、標記隱含波動率於歷史成交中沒有，只能自當下起逐次記錄)。
- 因子之計算(滾動平均、滾動 z 分數等)與因子目錄。
- 幣安之選擇權資料(只提供當下之鏈與 2023-06 起之波動指數，已到期合約之資料與歷史成交取不到)。
- 任何需金鑰之端點與下單。

## Test

```alias
npm test
```

測試以本機假伺服器(只聽 127.0.0.1 之系統配發埠)與假時鐘進行，不連外。
