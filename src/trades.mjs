import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import getOptReader from 'wsemi/src/getOptReader.mjs'
import timers from './timers.mjs'
import { fail, needStr, needRange, readInt, readStrict } from './opts.mjs'


const DAY = 86400000
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }
const COLS = ['ts', 'id', 'name', 'dir', 'amount', 'price', 'iv', 'index', 'mark']
const API_TRADES = '/api/v2/public/get_last_trades_by_currency_and_time'


/**
 * 解析選擇權之合約名(例'ETH-9JUN23-1850-P'；履約價之小數點可為'd'，例'XRP_USDC-27DEC24-0d5-C')。
 *
 * @function parseInstrument
 * @param {String} name - 合約名
 * @returns {Object|null} 回傳物件 { base, expiry(到期日08:00 UTC之毫秒), strike, type('C'或'P') }，不合者為null
 */
let parseInstrument = (name) => {
    if (typeof name !== 'string') {
        return null
    }
    let m = /^([A-Z0-9_]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:[.d]\d+)?)-([CP])$/.exec(name)
    if (!m || MONTHS[m[3]] === undefined) {
        return null
    }
    return { base: m[1], expiry: Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8), strike: Number(m[5].replace('d', '.')), type: m[6] }
}


/**
 * 一筆成交之正規化(只留其後彙整所需之欄，數值照原樣)：{ ts, id, name, dir, amount, price, iv, index, mark }。
 * 缺成交時刻、編號或合約名者，或編號、合約名含逗號與換行(無法存為CSV)者回null；其餘欄缺者為null(彙整時再依需要略過)；主動方(direction)非buy、sell者dir為null。
 *
 * @function normalizeTrade
 * @param {Object} t - API之成交物件(timestamp、trade_id、instrument_name、direction、amount、price、iv、index_price、mark_price)
 * @returns {Object|null} 正規化後之成交，無效者為null
 */
let normalizeTrade = (t) => {
    if (!t || typeof t !== 'object' || !Number.isFinite(t.timestamp) || t.trade_id === undefined || t.trade_id === null || typeof t.instrument_name !== 'string') {
        return null
    }
    let id = String(t.trade_id)
    if (/[,\r\n]/.test(id) || /[,\r\n]/.test(t.instrument_name)) {
        return null
    }
    let num = (v) => (Number.isFinite(v) ? v : null)
    return {
        ts: t.timestamp,
        id,
        name: t.instrument_name,
        dir: t.direction === 'buy' || t.direction === 'sell' ? t.direction : null,
        amount: num(t.amount),
        price: num(t.price),
        iv: num(t.iv),
        index: num(t.index_price),
        mark: num(t.mark_price),
    }
}


//csvOfTrades, 正規化後之成交 → CSV文字(首列為欄名; 無值之欄為空字串)
let csvOfTrades = (rows) => {
    let lines = [COLS.join(',')]
    for (let r of rows) {
        lines.push(COLS.map((k) => (r[k] === null || r[k] === undefined ? '' : String(r[k]))).join(','))
    }
    return lines.join('\n') + '\n'
}


//tradesOfCsv, CSV文字 → 正規化後之成交(欄名不符、欄數不符或時刻非數字即拋, 訊息不帶內容)
let tradesOfCsv = (text) => {
    let lines = String(text).split('\n').filter((s) => s.length > 0)
    if (lines[0] !== COLS.join(',')) {
        throw new Error('invalid trade file: unexpected header')
    }
    let num = (v) => (v === '' ? null : Number(v))
    return lines.slice(1).map((s) => {
        let p = s.split(',')
        if (p.length !== COLS.length || !Number.isFinite(Number(p[0]))) {
            throw new Error('invalid trade file: unexpected row')
        }
        return { ts: Number(p[0]), id: p[1], name: p[2], dir: p[3] === '' ? null : p[3], amount: num(p[4]), price: num(p[5]), iv: num(p[6]), index: num(p[7]), mark: num(p[8]) }
    })
}


//dayOfTs, 毫秒時間戳所屬之UTC日('YYYY-MM-DD')
let dayOfTs = (ts) => new Date(ts).toISOString().slice(0, 10)


//isDayStr, 是否為真實存在之UTC日字串('YYYY-MM-DD', 年份0000~9999)
let isDayStr = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return false
    }
    let t = Date.parse(`${v}T00:00:00Z`)
    return Number.isFinite(t) && dayOfTs(t) === v
}


//tsOfDay, UTC日('YYYY-MM-DD'，須為真實存在之日期)之起點毫秒; name為錯誤訊息中之參數名
let tsOfDay = (name, day) => {
    if (!isDayStr(day)) {
        fail(name, 'a day string in YYYY-MM-DD')
    }
    return Date.parse(`${day}T00:00:00Z`)
}


//fpOfDay, 某UTC日之每日檔路徑 <fdTrades>/<YYYY>/<YYYY-MM-DD>.csv.gz
let fpOfDay = (fdTrades, day) => path.join(fdTrades, day.slice(0, 4), `${day}.csv.gz`)


//invalidResponse, 回應之格式不符之錯誤(同請求端之失敗物件)
let invalidResponse = () => {
    let e = new Error('request failed: kind[invalidResponse] status[200] attempts[1]')
    e.kind = 'invalidResponse'
    e.httpStatus = 200
    e.code = null
    e.attempts = 1
    return e
}


/**
 * 下載[tStart, tEnd)(毫秒)內某幣別、某種類之全部成交：依時刻遞增分頁，下一頁自本頁最後之時刻起(含)並以成交編號去重；整頁皆已見過而該頁已達單頁上限(同一毫秒之筆數不小於opt.count)即無從以時刻續頁，拋錯。
 *
 * @async
 * @function downloadTrades
 * @param {Object} client - makeClient之回傳
 * @param {String} host - 例如'https://history.deribit.com'(歷史主機涵蓋全部期間含當日；即時主機只有近期)
 * @param {String} currency - 幣別，例如'ETH'、'BTC'
 * @param {String} kind - 種類，例如'option'
 * @param {Integer} tStart - 起(含)毫秒時間戳
 * @param {Integer} tEnd - 迄(不含)毫秒時間戳，須大於起
 * @param {Object} [opt={}] - 設定參數
 * @param {Integer} [opt.count=10000] - 單頁筆數(正整數，上限10000即交易所之上限)，給了而無效改用預設
 * @returns {Promise} resolve回傳 { trades(API之原物件，依回應之次序，不重複), pages }
 */
let downloadTrades = async (client, host, currency, kind, tStart, tEnd, opt = {}) => {
    needStr('currency', currency)
    needStr('kind', kind)
    let [a, b] = needRange('tStart', tStart, 'tEnd', tEnd)
    let rd = getOptReader('w-dwdata-deribit downloadTrades', opt)
    let count = readInt(rd, 'count', 10000, { use: 'safe', min: 1, max: 10000 }, 'an integer between 1 and 10000', '10000')
    let endInc = b - 1
    let seen = new Set()
    let out = []
    let cur = a
    let pages = 0
    while (true) {
        let res = await client.getResult(`${host}${API_TRADES}`, { currency, kind, start_timestamp: cur, end_timestamp: endInc, count, sorting: 'asc' })
        pages++
        if (!res || !Array.isArray(res.trades)) {
            throw invalidResponse()
        }
        let fresh = 0
        let last = cur
        for (let t of res.trades) {
            if (!t || !(t.timestamp >= a && t.timestamp <= endInc)) {
                continue
            }
            last = Math.max(last, t.timestamp)
            if (!seen.has(t.trade_id)) {
                seen.add(t.trade_id)
                out.push(t)
                fresh++
            }
        }
        if (!res.has_more || res.trades.length === 0) {
            break
        }
        if (fresh === 0) {
            if (res.trades.length >= count) {
                let e = new Error('too many trades at one timestamp for paging: increase opt.count')
                e.kind = 'pagingLimit'
                e.httpStatus = null
                e.code = null
                e.attempts = 0
                throw e
            }
            cur = last + 1
        }
        else {
            cur = last
        }
        if (cur > endInc) {
            break
        }
    }
    return { trades: out, pages }
}


//writeDayFile, 寫某日之每日檔: 先寫暫存檔再改名, 失敗時刪除暫存檔
let seq = 0
let writeDayFile = (fp, rows) => {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    seq++
    let tmp = `${fp}.${process.pid}.${seq}.tmp`
    try {
        fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(csvOfTrades(rows), 'utf8')))
        fs.renameSync(tmp, fp)
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp)
        }
        catch (e) {
            //暫存檔不存在
        }
        throw err
    }
}


/**
 * 逐日(UTC日)下載並存檔；已有檔之日不重抓(不送請求)；只處理已結束且過了寬限之日(日終 + opt.timeGrace不晚於現在)。
 * 請求失敗之日不寫檔(下次執行再抓，不標註為無數據；依時間查成交時「空」是有效之回答，0筆之日照樣寫出只有欄名之檔)。
 * 停止本次執行之後續請求：交易所維護(503)或流量限制用盡重試；連續opt.netFailTimes日皆為連線層失敗(連線錯誤、逾時)；未送之日列入failed(kind為'notRequested')。
 * 某日之同一毫秒筆數不小於opt.count而無從分頁者(kind為'pagingLimit')列入failed，不停止本次執行。
 * 必須參數無效時reject(先於任何連網與寫檔)，訊息為'invalid <名稱>: must be <種類>'，不帶輸入值。
 *
 * @async
 * @function saveTrades
 * @param {Object} client - makeClient之回傳
 * @param {String} host - 歷史主機
 * @param {String} currency - 幣別，例如'ETH'
 * @param {String} kind - 種類，例如'option'
 * @param {String} fdTrades - 每日檔之資料夾
 * @param {String} dayStart - 起日(UTC，'YYYY-MM-DD')
 * @param {Object} [opt={}] - 設定參數
 * @param {String} [opt.dayEnd] - 迄日(含；UTC，'YYYY-MM-DD')，未給為最近一個已完整之日，給了而無效即拋(決定下載範圍，不改用預設)
 * @param {Integer} [opt.timeGrace=600000] - 日終後之寬限毫秒數(非負整數，上限2147483647)，給了而無效改用預設
 * @param {Integer} [opt.netFailTimes=3] - 連續此數之日皆為連線層失敗時停止本次執行之後續請求(非負整數)，0代表不停止，給了而無效改用預設
 * @param {Integer} [opt.count=10000] - 單頁筆數，見downloadTrades
 * @returns {Promise} resolve回傳 { days(範圍內之日數), saved: [{ day, n, dropped, pages }], skipped(已有檔之日數), failed: [{ day, kind, httpStatus, attempts }], halted(null或停止之原因'maintenance'、'rateLimited'、'network') }
 */
let saveTrades = async (client, host, currency, kind, fdTrades, dayStart, opt = {}) => {
    needStr('currency', currency)
    needStr('kind', kind)
    needStr('fdTrades', fdTrades)
    let t0 = tsOfDay('dayStart', dayStart)
    let rd = getOptReader('w-dwdata-deribit saveTrades', opt)
    let dayEnd = readStrict(rd, 'dayEnd', null, isDayStr, 'a day string in YYYY-MM-DD')
    let timeGrace = readInt(rd, 'timeGrace', 600000, { use: 'timer' }, 'an integer between 0 and 2147483647', '600000')
    let netFailTimes = readInt(rd, 'netFailTimes', 3, { use: 'count' }, 'a non-negative integer', '3')
    let count = rd.read('count') //單頁筆數交downloadTrades檢測
    let trace = client.trace

    //lastDone, 最近一個已完整之日(其日終 + 寬限不晚於現在)之起點
    let now = timers.now()
    let lastDone = Math.floor((now - timeGrace) / DAY) * DAY - DAY
    let t1 = dayEnd === null ? lastDone : Math.min(tsOfDay('opt.dayEnd', dayEnd), lastDone)
    let r = { days: 0, saved: [], skipped: 0, failed: [], halted: null }
    let netFails = 0
    for (let t = t0; t <= t1; t += DAY) {
        let day = dayOfTs(t)
        r.days++
        let fp = fpOfDay(fdTrades, day)
        if (fs.existsSync(fp)) {
            r.skipped++
            if (trace) {
                trace('day', { day, state: 'skipped', n: null, kind: null })
            }
            continue
        }
        if (r.halted) {
            r.failed.push({ day, kind: 'notRequested', httpStatus: null, attempts: 0 })
            if (trace) {
                trace('day', { day, state: 'notRequested', n: null, kind: 'notRequested' })
            }
            continue
        }
        try {
            let d = await downloadTrades(client, host, currency, kind, t, t + DAY, { count, debug: rd.debug, funLog: rd.funLog })
            let rows = d.trades.map(normalizeTrade)
            let ok = rows.filter(Boolean)
            writeDayFile(fp, ok)
            r.saved.push({ day, n: ok.length, dropped: rows.length - ok.length, pages: d.pages })
            netFails = 0
            if (trace) {
                trace('day', { day, state: 'saved', n: ok.length, kind: null })
            }
        }
        catch (e) {
            if (!e || typeof e.kind !== 'string') {
                throw e
            }
            r.failed.push({ day, kind: e.kind, httpStatus: e.httpStatus === undefined ? null : e.httpStatus, attempts: e.attempts === undefined ? 0 : e.attempts })
            if (trace) {
                trace('day', { day, state: 'failed', n: null, kind: e.kind })
            }
            if (e.kind === 'maintenance' || e.kind === 'rateLimited') {
                r.halted = e.kind
            }
            else if (e.kind === 'network' || e.kind === 'timeout') {
                netFails++
                if (netFailTimes > 0 && netFails >= netFailTimes) {
                    r.halted = 'network'
                }
            }
            else {
                netFails = 0
            }
            if (r.halted && trace) {
                trace('halt', { day, reason: r.halted })
            }
        }
    }
    return r
}


/**
 * 讀[tStart, tEnd)(毫秒)內之成交(自每日檔；可跨日，供使用端以自己之日界取用)。
 * 範圍內尚無檔之UTC日列入missingDays(0筆之日有檔，不算缺)；每日檔損毀(欄名不符、欄數不符、無法解壓)者拋錯。
 *
 * @function readTrades
 * @param {String} fdTrades - 每日檔之資料夾
 * @param {Integer} tStart - 起(含)毫秒時間戳
 * @param {Integer} tEnd - 迄(不含)毫秒時間戳，須大於起
 * @returns {Object} 回傳物件 { trades(正規化後，依檔內之次序), missingDays(尚無檔之UTC日字串陣列) }
 */
let readTrades = (fdTrades, tStart, tEnd) => {
    needStr('fdTrades', fdTrades)
    let [a, b] = needRange('tStart', tStart, 'tEnd', tEnd)
    let trades = []
    let missingDays = []
    for (let t = Math.floor(a / DAY) * DAY; t < b; t += DAY) {
        let day = dayOfTs(t)
        let fp = fpOfDay(fdTrades, day)
        if (!fs.existsSync(fp)) {
            missingDays.push(day)
            continue
        }
        for (let r of tradesOfCsv(zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8'))) {
            if (r.ts >= a && r.ts < b) {
                trades.push(r)
            }
        }
    }
    return { trades, missingDays }
}


export { COLS, parseInstrument, normalizeTrade, csvOfTrades, tradesOfCsv, dayOfTs, isDayStr, tsOfDay, fpOfDay, downloadTrades, saveTrades, readTrades }
