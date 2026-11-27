# 規則帳本

本檔為套件設計與開發階段之規則帳本(藍圖),為要求程式碼須長成什麼樣,或由規格產出之測試(項目/說明/流程)有哪些,包含軸、單一擁有者、已知限制、破壞性變更紀錄,以及對應是哪些測試檔案或指令等,由agent自行編列、擴充與維護.當前已做到哪些記於`sgud/state/state.md`.過長時依類型拆為`rulebook_<類型>.md`,本檔只留索引.

本套件源自使用端之需求(Gitea #225:新增Deribit公開行情之下載套件),提案之原型僅供參考,以下為定案之規則.測試之執行:`npm test`;單檔:`npx mocha --no-parallel test/<檔> --timeout 60000`;變異:`node test/tools/mutants.mjs --out ./tmp/mut`(輸出資料夾須在套件樹下).

## 軸

- **端點與主機**:逐筆成交 `get_last_trades_by_currency_and_time`(歷史主機,涵蓋全部期間含最近2小時;即時主機只有近期)、隱含波動指數 `get_volatility_index_data`(只在即時主機,歷史主機回400).
- **請求結果之種類(kind)**:`ok`、`invalidResponse`、`rateLimited`、`maintenance`、`badRequest`、`httpError`、`timeout`、`network`;逐日存檔另有 `pagingLimit`(同毫秒筆數達單頁上限)與 `notRequested`(停止後未送).
- **日**:一律 UTC 日(`YYYY-MM-DD`);使用端之日界(任意時區)只在讀取與彙整時以毫秒起訖給.
- **選項之處置**:必須參數(位置參數)無效即拋/reject;決定資料口徑、下載來源與範圍、網路出口之選項給了而無效即拋;其餘執行參數給了而無效改用預設(依 dspec〈輸入參數之檢測機制〉).

## 規則

### R1 職責與不含(主控裁定 1~7)

- 職責:Deribit 公開行情(不需金鑰)之下載與落檔(逐筆成交每日檔、波動指數 CSV),以及由每日檔彙整之格與每日基本量(純函式,與合約名之解析綁在一起,故 `aggregateTrades`、`summarizeCells` 皆留本套件).
- **不含**:定時同步(使用端以排程呼叫 `saveTrades`)、當下之鏈快照、幣安之選擇權資料、因子之計算與目錄、任何需金鑰之端點與下單.
- 外部依賴只有 `axios` 與 `wsemi`(版本同 w-dwdata-binance);不新增其他外部依賴.
- 盤點:`Grep "^import" src` 之外部套件只應有 `axios`、`wsemi/src/*`、Node 內建(`fs`、`path`、`zlib`).

### R2 逐筆成交之存放格式(主控裁定 1)

- 路徑 `<fdTrades>/<YYYY>/<YYYY-MM-DD>.csv.gz`,欄 `ts,id,name,dir,amount,price,iv,index,mark`,首列為欄名,無值之欄為空字串.
- **檔存在 = 該日已完整下載**:先寫暫存檔(`<檔>.<pid>.<序號>.tmp`)再改名,寫入失敗時刪除暫存檔;0 筆之日寫只有欄名之檔;請求失敗之日不寫檔.已有檔之日不送請求.
- 只處理 `日終 + timeGrace ≤ 現在` 之日(`timeGrace` 預設 600000);`dayEnd` 超過最近一個已完整之日者以後者為準.
- 編號或合約名含逗號、換行者無法存為 CSV,正規化時整筆丟棄並計入 `dropped`.
- 讀取:欄名不符、欄數不符、時刻非數字、無法解壓者拋錯,不靜默略過;半開區間 `[tStart, tEnd)`.
- 盤點:`Grep "csv.gz|COLS" src`(只應在 `src/trades.mjs`).
- 測試:`unit-aggregate` A2;`api-download` D3、D4.

### R3 分頁與去重

- 區間為半開 `[tStart, tEnd)`:請求之 `end_timestamp` 為 `tEnd − 1`(交易所之迄為含);回應內範圍外之筆濾除.
- 依時刻遞增分頁,下一頁自本頁末筆之時刻起(**含**),以 `trade_id` 去重(同毫秒者跨頁不重不漏).
- 整頁皆已見過:該頁已達單頁上限(同一毫秒之筆數不小於 `count`,無從以時刻續頁)⇒ 拋錯(`kind: 'pagingLimit'`,訊息 `too many trades at one timestamp for paging: increase opt.count`,`saveTrades` 列入 `failed` 而不停止);未達上限而仍有後續(伺服器之異常回應)⇒ 前進 1 毫秒.
- `count` 預設 10000(交易所上限),給了而無效(含 20000)改用預設.
- 盤點:`Grep "seen|has_more|pagingLimit" src/trades.mjs`.
- 測試:`api-download` D1、D2、D2b、D5.

### R4 請求之分類與重試(依提案與使用者 2026-11-19 之裁示:請求失敗不算缺、不標註)

- 分類(`src/request.mjs` 之 `classifyResult`):429 或錯誤代碼 10028(任何 HTTP 狀態)⇒ `rateLimited`;2xx 且有 `result`(非 `null`)⇒ `ok`;2xx 無 `result` ⇒ `invalidResponse`;503 ⇒ `maintenance`;400 ⇒ `badRequest`;其餘 ⇒ `httpError`;無回應 ⇒ `timeout`(因逾時中止)或 `network`.
- 重試:`network`、`timeout`、`rateLimited`、`maintenance`、`invalidResponse`、5xx;不重試:400、其餘 4xx、3xx(不跟隨轉址,`maxRedirects: 0`).
- 第 i 次重試前等待 `timeRetry × 3^(i−1)`,不超過 `timeRetryMax`;預設 3 次、1000、60000;成功時不多送請求、不多等待.
- 失敗物件:`Error` 帶 `kind`、`httpStatus`、`code`(回應內之錯誤代碼)、`attempts`;訊息 `request failed: kind[…] status[…] attempts[…]`,不帶網址與參數.
- 單一請求之逾時以 `AbortController` 自送出至收完回應計(`timeRequest`,預設 60000).
- 盤點:`Grep "retry:|kind:" src/request.mjs`.
- 測試:`api-request` Q1~Q4、Q8、Q9.

### R5 `saveTrades` 之失敗與停止

- 停止本次執行之後續請求:`maintenance`、`rateLimited`(用盡重試);連續 `netFailTimes`(預設 3,0 為不停止)日皆為 `network`/`timeout`(中間有成功之日歸零,其餘種類之失敗亦歸零).未送之日列入 `failed`(`kind: 'notRequested'`、`attempts: 0`).
- 5xx 用盡、`invalidResponse`、`badRequest`、`pagingLimit` 只列入 `failed`,不停止.
- 檔案寫入之錯誤(非請求失敗,無 `kind`)直接 reject.
- 回傳 `{ days, saved: [{ day, n, dropped, pages }], skipped, failed: [{ day, kind, httpStatus, attempts }], halted }`.
- 測試:`api-download` D3、D5.

### R6 節流

- 相鄰兩次請求之起始至少相隔 `minGapMs`(預設 220);同一下載器之並行呼叫共用同一節流(`nextSlot`);以**單調時鐘**(`timers.mono`)計,不受系統時間往回撥之影響(日終之判定用牆上時鐘 `timers.now`).
- 測試:`api-request` Q5、Q11;`api-download` D7.

### R7 觀察回調 `opt.onTrace`(dspec〈計時器相關函數之觀察回調與測試〉)

- 單一擁有者 wsemi `getTrace`;事件 `throttle { wait }`、`attempt { attempt, kind, httpStatus }`、`retry { attempt, wait, kind }`、`day { day, state, n, kind }`、`halt { day, reason }`;同步、凍結、回調之拋錯與 rejection 皆忽略、未給時不組事件.
- **重試、節流之等待與請求逾時不以實際延時核對**:`src/timers.mjs` 之 `now`、`mono`、`sleep`、`timeout`、`cancel` 為可替換之物件屬性(套件內之等待與計時器一律經此),測試以 `test/tools/fakeClock.mjs` 注入假時鐘:`sleep` 登記虛擬到期時刻,由 `setImmediate` 依到期先後推進,以事件與 `sleeps` 核對等待之毫秒數;`timeout`(請求逾時)不自動到期,測試以「伺服器已收到請求」為同步點後呼叫 `fireTimeouts()` 觸發(`api-request` Q8),並以 `pendingDelays()` 核對登記之毫秒數、`pendingTimeouts()` 核對請求結束後已取消.唯一之真實計時器為防懸置上限(伺服器端未觀察到連線中止時 10 秒後失敗).
- 殷鑑:舊版 Q8 以真實計時器(`timeRequest: 30`)逾時,排程雜訊下偶有請求尚未抵達伺服器即被中止(`closed.length === 2` 之斷言失敗,實測 1/410 次連跑;雜訊探測 1/300 次伺服器未收到請求),改為事件同步.
- 假時鐘不得往回撥而沿用同一下載器(請求端記得下一次可起始之時刻);須往回撥者另建下載器.
- 測試:`api-request` Q2~Q8;`api-download` D3、D5、D7.

### R8 輸入之檢測(dspec〈輸入參數之檢測機制〉)

- opt 之逐鍵讀取一律經 wsemi `getOptReader`(不自寫 `readIntOpt` 類),數字類以 `iseint`/`isenum` 判定,通過後轉為數值使用(數字字串可,`-0` 以 0 計);`opt.debug` 為 `true` 時警告(固定詞彙,不含輸入值).
- 必須參數:`currency`、`kind`、`fdTrades`、`fp` 為非空字串(不含 NUL);`tStart`、`tEnd` 為毫秒時間戳且 `tEnd > tStart`;`dayStart` 為真實存在之 UTC 日.無效即拋(Promise 者 reject),先於任何連網與寫檔,訊息 `invalid <名稱>: must be <種類>`,不帶輸入值.
- 給了而無效即拋(不改用預設)者:`hostHistory`、`hostLive`(下載來源)、`proxy`(網路出口,改用預設會直連)、`dayEnd`(下載範圍)、`moneyness`、`priceInCoin`、`minDte`(格之歸屬與權利金之意義)、`resolution`(取樣間隔).
- 給了而無效改用預設者:`minGapMs`、`retryTimes`、`timeRetry`、`timeRetryMax`、`timeRequest`、`timeGrace`、`netFailTimes`、`count`.
- opt 為 `null`、不可讀之 Proxy 皆視為未給;不改寫呼叫端之物件(代理之設定複製為新物件).
- 盤點:`Grep "readHost|readProxy|readStrict|readInt|needStr|needRange" src`;`Grep "function readIntOpt|pickOpt" src`(應無).
- 測試:`unit-aggregate` A4;`api-request` Q6;`api-download` D2、D6、D8、D9.

### R9 彙整(純函式)

- 格之鍵 `${C|P}${B|S}|${價性級}|${日數級}`,值 `[口數, 權利金, Σ iv × 口數, 有 iv 之口數, 筆數]`;界之表 `M_EDGES_PCT`、`M_EDGES_STD`、`D_EDGES`(恰在界上歸較高之級);到期日 08:00 UTC,到期當刻入格、其後不入格.
- 無從歸格者(含非物件)計入 `skipped`;`'std'` 須有正之 iv;`priceInCoin` 決定權利金乘不乘指數價;價非正者權利金以 0 計.
- `summarizeCells`:分母為 0 者 `NaN`(含分子非 0 之不一致格);格之格式不符即拋.
- 手算值為斷言依據(`unit-aggregate` A3、A5、A6),變異見下.

### R10 波動指數

- 每次回應之 `continuation` 為下一次可直接當迄(含)之時刻,直到無 `continuation`、回應為空,或 `continuation ≥ 本次之迄`(不前進即停止,防無窮續頁);依時刻去重(重疊之頁)、遞增排序、範圍外之點濾除;區間為半開 `[tStart, tEnd)`(R13),送交易所之 `end_timestamp` 仍為 `tEnd`(交易所之迄為含,此請求形式已實連驗證;不改送 `tEnd − 1` 以免依賴未驗證之邊界行為),恰在 `tEnd` 之點於本端濾除(`p[0] < tEnd`).
- `resolution` 預設 3600,秒數(正整數)或 `'1D'`;`saveVolIndex` 先寫暫存檔再改名,整檔重寫,範圍內無資料時為只有欄名之檔.
- 測試:`api-download` D8(半開邊界、相鄰區間相接、`continuation` 各形)、D10;變異 V02、V03、V09~V12.

### R11 測試之配置與守則

- 前綴 `unit-`、`api-`;假伺服器只聽 `127.0.0.1` 之系統配發埠(`test/tools/fakeServer.mjs`),不連外;測試設 `NO_PROXY` 使 axios 不因環境變數而走代理.
- 暫存於 `test/_tmp/api-download/`,測完即刪;測試不寫 `./tmp/`.
- 實連(Deribit 公開端點)不入自動測試,只在需要核對時手動實跑一次,以最小樣本(不得大量下載).
- 變異:`test/tools/mutants.mjs`(鏡像副本,不改動套件內檔案;錨點不唯一報 ANCHOR-FAIL);每次改碼後重跑全部.

### R12 發布與建置(dspec〈自有套件之發布與建置腳本〉、〈自有套件之npm發布範圍〉)

- 型 A:`script.txt` 為使用者維護,agent 不改;`toolg/` 為標準寫法(`gDistRollup.mjs` 以 `./src`、`./dist`,入口 `WDwdataDeribit.mjs`,產出 `dist/w-dwdata-deribit.umd.js`;`external`/`globals` 為 `path`、`fs`、`zlib`).
- 本套件為 Node 端(用 `fs`、`zlib`),**仍產 `dist/`**:`script.txt` 之 `gDistRollup`、`genDocsDist` 列為標準 A 型,`package.json` 之 `main` 指向 `dist/w-dwdata-deribit.umd.js`(同 w-dwdata-binance 等 Node 端自有套件);`dist/`、`docs/` 於發布時由發布列自動產製,不列為待辦.
- 不提供 `.npmignore`(無外部執行檔、無 ≥10MB 之非程式碼資料夾).
- 公開庫:程式、測試、`sgud/`、README、註解不得含使用端之專案名、本機路徑、內網位址.
- 盤點:主控之去識別檢查工具(private-guard)應為 CLEAN;`git status` 不應有 `dist/`、`docs/` 以外之非預期產物.

### R13 區間語意:全套件統一為半開 `[tStart, tEnd)`(主控 2026-11-27 複審之要求;套件尚未發布,不相容舊行為)

- 凡以毫秒時間戳 `tStart`、`tEnd` 給區間者——`downloadTrades`、`readTrades`、`summarizeRange`、`downloadVolIndex`、`saveVolIndex`——一律半開:恰在 `tStart` 之資料入、恰在 `tEnd` 之資料不入;`tEnd` 須大於 `tStart`(`needRange`).
- 理由:原型之成交為半開而波動指數為含兩端,使用端以相同之日界呼叫兩者時,邊界點於相鄰兩日各出現一次.統一後相鄰區間 `[a, b)`、`[b, c)` 之結果相接,不重複、不遺漏.
- `saveTrades` 之 `dayStart`、`opt.dayEnd` 以 UTC 日為單位(含 `opt.dayEnd` 該日),不屬時間戳區間,不改.
- README 之區間語意只在〈Time ranges〉一處說明,各函式之列只寫「區間內」.
- 盤點(各函式之端點判定處,皆應為 `< tEnd` 或 `≤ tEnd − 1`):`Grep "needRange|endInc|r\.ts <|t < b|p\[0\] <" src`(共 `trades.mjs` 之 `endInc`、`r.ts < b`、`t < b` 與 `volIndex.mjs` 之 `p[0] < b`);`Grep "<= b|\[tStart, tEnd\]" src README.md g-ETH.mjs`(應無;`<= endInc` 僅 `trades.mjs` 一處,`endInc` 即 `tEnd − 1`).
- 測試:`api-download` D1(成交下載之迄點與起點)、D3(讀取之迄點、起點與跨日界之缺日)、D8(波動指數之半開邊界、相鄰區間相接、相鄰兩檔之資料列相接);變異 T02、T03、T15、T16、T18、V02、V03、V09~V12(`V10` 為改回含迄點).
