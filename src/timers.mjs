//timers, 時間之來源與等待; 為可替換之物件屬性, 供測試注入假時鐘(sleep只推進虛擬時間而不真的等待), 套件內之節流、重試等待、請求逾時與日終判定一律經此
//now為牆上時鐘(判定某UTC日是否已結束); mono為單調時鐘(節流之間隔, 不受系統時間被往回撥之影響)
//timeout與cancel為請求逾時之計時器(到期呼叫fn, 傳回之代號交cancel取消)
let timers = {
    now: () => Date.now(),
    mono: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeout: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h),
}


export default timers
