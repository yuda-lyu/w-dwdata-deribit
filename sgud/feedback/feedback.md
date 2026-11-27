# 回饋

本檔記任務中發現之自有套件、全域技能、全域設定之調整與抽提提案,只增不改(處置結果另記一列,寫明承接哪一列);回饋是紀錄與提案,實際修改走各自之通報管道.

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-27 | 自有套件 | wsemi `getOptReader` | 回傳之 `rd(key, def, check, …)` 依設計原樣回傳值(不轉換),數字字串通過 `iseint`/`isenum` 後仍是字串;各套件須各寫一份「通過後轉數值」之小函數(本套件 `readInt`/`toNum`,w-dwdata-binance 之 `readIntOpt` 同形),易漏轉而違反 K4(檢測之值即使用之值).建議於 wsemi 提供整數與有效數字之讀取變體(通過後回轉換值,`-0` 以 0 計),各套件不再各寫 | `src/opts.mjs` 之 `toNum`、`readInt`;`getOptReader` 之說明「檢測之值即使用之值,不轉換」(`node_modules/wsemi/src/getOptReader.mjs:32`) |
| 2026-11-27 | 全域技能 | role-coder-for-test(計時器相關之測試,`references/timer-tests.md`) | 補「假時鐘之 `sleep` 不可立即推進全域時鐘」:並行之多個等待(同一時刻起算)會被前一個等待之結束拉後,節流之並行案得 `[300, 300]` 而非 `[300, 600]`;`sleep` 應登記虛擬到期時刻,由事件迴圈空檔(`setImmediate`)依到期先後推進並喚醒.另補「被測物記得下一次可起始之時刻(節流)時,假時鐘不得往回撥而沿用同一被測物」,與「請求逾時以真實之短計時器(如 30 毫秒)測會因排程雜訊而偶發(請求尚未抵達伺服器即被中止),應讓逾時計時器亦可替換,於伺服器已收到請求之事件後再觸發」 | `test/tools/fakeClock.mjs`;`sgud/exp/experience.md`〈2026-11-27 建立本套件〉之假時鐘、`nextSlot` 與逾時三條(逾時:連跑 1/410 偶發,雜訊探測 1/300) |
| 2026-11-27 | 全域設定 | dspec〈自有套件之發布與建置腳本〉之 `gDistRollup.mjs` 範本 | 自 w-dwdata-binance 複製之 `gDistRollup.mjs` 含單入口用不到之 `import getFiles`,於 `eslint toolg` 為 `no-unused-vars` 錯誤(單入口者不需 `getFiles`);建議範本分「單入口」與「多入口」兩式,單入口式不匯入 `getFiles` | `npx eslint src test toolg --ext .mjs` 之輸出(`toolg/gDistRollup.mjs:2:8 'getFiles' is defined but never used`);本套件已移除該匯入 |
| 2026-11-28 | 全域設定 | dspec 新增建議:以時間戳給區間之函數一律半開 `[start, end)` | 自有套件中以起訖時間戳取資料之函數(下載、讀取、彙整)語意不一(本套件原型之成交為半開、波動指數為含兩端),使用端以相同日界呼叫時邊界點重複或遺漏;建議於跨套件規格載明「以時間戳給區間者一律半開,JSDoc 與 README 於一處說明,測試含恰在起點入、恰在迄點不入、相鄰區間相接三案」,並以測試之假伺服器與真實 API 同形(迄為含時回應含迄點)為前提 | `sgud/rule/rulebook.md` R13;`test/api-download.test.mjs` D8;第 686 項複審 |
