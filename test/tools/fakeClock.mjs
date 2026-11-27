//假時鐘(測試輔助): 替換src/timers.mjs之now、mono、sleep、timeout與cancel
//sleep不真的等待, 而是登記一個虛擬之到期時刻, 由事件迴圈之空檔(setImmediate)依到期先後逐一推進虛擬時鐘並喚醒,
//故並行之多個等待各依其到期時刻先後結束(同一時刻起算之並行等待不會被前一個等待之結束拉後), 並記錄各次等待之毫秒數
//timeout(請求逾時之計時器)不自動到期, 只在測試呼叫fireTimeouts()時依到期先後觸發: 逾時以事件(伺服器已收到請求)為同步點再觸發, 不以實際延時
//節流與重試之等待、請求之逾時、日終之判定因而可精確核對(以事件onTrace與sleeps核對), 不以實際延時
import timers from '../../src/timers.mjs'


/**
 * 安裝假時鐘
 *
 * @param {Number} [t0=Date.UTC(2024, 0, 1)] - 虛擬時鐘之起點(毫秒)
 * @returns {Object} { sleeps(各次等待之毫秒數，依呼叫次序), now(), set(ms), fireTimeouts(), pendingTimeouts(), pendingDelays(), restore() }
 */
let installFakeClock = (t0 = Date.UTC(2024, 0, 1)) => {
    let orig = { now: timers.now, mono: timers.mono, sleep: timers.sleep, timeout: timers.timeout, cancel: timers.cancel }
    let t = t0
    let sleeps = []
    let pending = []
    let tos = []
    let seq = 0
    let scheduled = false
    let pump = () => {
        if (scheduled || pending.length === 0) {
            return
        }
        scheduled = true
        setImmediate(() => {
            scheduled = false
            pending.sort((a, b) => a.at - b.at || a.seq - b.seq)
            let x = pending.shift()
            t = Math.max(t, x.at)
            x.resolve()
            pump()
        })
    }
    timers.now = () => t
    timers.mono = () => t
    timers.sleep = (ms) => {
        sleeps.push(ms)
        return new Promise((resolve) => {
            pending.push({ at: t + ms, seq: seq++, resolve })
            pump()
        })
    }
    timers.timeout = (fn, ms) => {
        let h = { at: t + ms, seq: seq++, fn, ms }
        tos.push(h)
        return h
    }
    timers.cancel = (h) => {
        tos = tos.filter((x) => x !== h)
    }
    return {
        sleeps,
        now: () => t,
        set: (ms) => {
            t = ms
        },
        fireTimeouts: () => {
            let list = tos.sort((a, b) => a.at - b.at || a.seq - b.seq)
            tos = []
            for (let h of list) {
                t = Math.max(t, h.at)
                h.fn()
            }
            return list.length
        },
        pendingTimeouts: () => tos.length,
        pendingDelays: () => tos.map((h) => h.ms),
        restore: () => {
            timers.now = orig.now
            timers.mono = orig.mono
            timers.sleep = orig.sleep
            timers.timeout = orig.timeout
            timers.cancel = orig.cancel
        },
    }
}


export { installFakeClock }
