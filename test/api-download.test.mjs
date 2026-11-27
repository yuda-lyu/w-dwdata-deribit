//w-dwdata-deribit: 以本機假伺服器(只聽127.0.0.1之系統配發埠)驗下載之分頁與去重、半開區間、逐日存檔與續傳、失敗與停止、跨日讀取、波動指數之續頁、必須參數與選項之檢測
//時間以假時鐘(test/tools/fakeClock.mjs)控制, 重試與節流之等待不實際發生; 暫存檔在 test/_tmp/api-download/(測完即刪)
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import getOptReader from 'wsemi/src/getOptReader.mjs'
import WDwdataDeribit from '../src/WDwdataDeribit.mjs'
import { normalizeTrade, fpOfDay } from '../src/trades.mjs'
import { aggregateTrades } from '../src/aggregate.mjs'
import { installFakeClock } from './tools/fakeClock.mjs'
import { startServer, sendJson, withNoProxy } from './tools/fakeServer.mjs'


let FD = path.join(path.dirname(fileURLToPath(import.meta.url)), '_tmp', 'api-download')
let DAY = 86400000
let H = 3600000
let D1 = Date.UTC(2024, 2, 1)

//手造之成交(各值相異): 三個UTC日(03-01 ~ 03-03); 03-01內有5筆同毫秒者; 恰在日界(03-02 00:00:00.000)者1筆; 02-29無成交
let NAMES = ['ETH-8MAR24-3000-P', 'ETH-8MAR24-3600-C', 'ETH-29MAR24-3400-C', 'ETH-29MAR24-2800-P', 'ETH-2MAR24-3350-C']
let TRADES = []
{
    let push = (ts) => {
        let i = TRADES.length
        TRADES.push({ trade_seq: i + 1, trade_id: `ETH-${1000 + i}`, timestamp: ts, tick_direction: i % 4, price: 0.004 + 0.0007 * (i % 11), mark_price: 0.0041 + 0.0007 * (i % 11), iv: 48 + (i % 13) * 1.5, instrument_name: NAMES[i % NAMES.length], index_price: 3300 + i * 0.37, direction: (i * 7) % 3 === 0 ? 'sell' : 'buy', amount: 1 + (i % 7) * 0.5 })
    }
    for (let k = 0; k < 23; k++) {
        push(D1 + 600000 + k * 3311000)
    }
    for (let k = 0; k < 5; k++) {
        push(D1 + 14 * H + 777)
    }
    push(D1 + DAY)
    for (let k = 0; k < 17; k++) {
        push(D1 + DAY + 900000 + k * 4777000)
    }
    for (let k = 0; k < 9; k++) {
        push(D1 + 2 * DAY + 1200000 + k * 5333000)
    }
    TRADES.sort((p, q) => p.timestamp - q.timestamp || p.trade_seq - q.trade_seq)
}

//波動指數: 每小時一點, 自03-01起200點
let DVOL = Array.from({ length: 200 }, (_, k) => [D1 + k * H, 60 + Math.sin(k * 0.3) * 4, 66 + (k % 5), 55 - (k % 3), 61 + Math.cos(k * 0.2) * 3])


describe('api-download', function() {

    let srv = null
    let host = ''
    let restoreProxy = null
    let fc = null
    let S = null
    let resetS = () => {
        S = { failPlan: [], badDays: new Set(), netDays: new Set(), limitDays: new Set(), errDays: new Set(), shapeDays: new Set(), junk: false, maxPts: 50, extra: false, overlap: false, stuck: false, contExact: false }
    }
    let dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
    let tradeQs = () => srv.requests.filter((r) => r.url.includes('get_last_trades')).map((r) => new URL(r.url, 'http://127.0.0.1').searchParams)

    before(async function() {
        restoreProxy = withNoProxy()
        fs.rmSync(FD, { recursive: true, force: true })
        fs.mkdirSync(FD, { recursive: true })
        resetS()
        srv = await startServer((req, res, u) => {
            let send = (status, obj) => sendJson(res, status, obj)
            if (S.failPlan.length) {
                return send(S.failPlan.shift(), { jsonrpc: '2.0', error: { code: -1, message: 'x' } })
            }
            let q = u.searchParams
            let a = Number(q.get('start_timestamp'))
            let b = Number(q.get('end_timestamp'))
            if (u.pathname === '/api/v2/public/get_last_trades_by_currency_and_time') {
                if (q.get('kind') === 'bad') {
                    return send(400, { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params' } })
                }
                let d = dayOf(a)
                if (S.badDays.has(d)) {
                    return send(503, { jsonrpc: '2.0', error: { code: 13028, message: 'temporarily_unavailable' } })
                }
                if (S.limitDays.has(d)) {
                    return send(429, { jsonrpc: '2.0', error: { code: 10028, message: 'too_many_requests' } })
                }
                if (S.errDays.has(d)) {
                    return send(500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal' } })
                }
                if (S.netDays.has(d)) {
                    req.socket.destroy()
                    return null
                }
                if (S.shapeDays.has(d)) {
                    return send(200, { jsonrpc: '2.0', result: { has_more: false } })
                }
                let count = Number(q.get('count'))
                let all = q.get('currency') === 'ETH' ? TRADES.filter((t) => t.timestamp >= a && t.timestamp <= b) : []
                let page = all.slice(0, count)
                if (S.junk && page.length > 0) {
                    //無編號之成交: 正規化後應被丟棄
                    page = [{ timestamp: page[0].timestamp, instrument_name: 'ETH-8MAR24-3000-P' }, ...page]
                }
                return send(200, { jsonrpc: '2.0', result: { trades: page, has_more: all.length > count } })
            }
            if (u.pathname === '/api/v2/public/get_volatility_index_data') {
                let all = DVOL.filter((p) => p[0] >= a && p[0] <= b)
                let part = all.slice(Math.max(0, all.length - S.maxPts))
                let cont = all.length > part.length ? part[0][0] - 1 : null
                if (cont !== null && S.overlap) {
                    cont = part[0][0] //重疊: 下一頁含本頁最早之點
                }
                if (cont !== null && S.stuck) {
                    cont = b //不前進之continuation
                }

                //continuation為下一次可直接當迄(含)之時刻: 預設為本頁最早之點之前1毫秒, S.contExact時為尚未回傳之下一個較早之點之時刻本身
                if (cont !== null && S.contExact) {
                    cont = all[all.length - part.length - 1][0]
                }

                //S.extra: 回應另夾帶範圍外(起點之前與迄點之後)之點, 驗下載端會濾除
                return send(200, { jsonrpc: '2.0', result: { data: S.extra ? [[a - H, 1, 2, 0.5, 1.5], ...part, [D1 + 1000 * H, 1, 2, 0.5, 1.5]] : part, continuation: cont } })
            }
            return send(404, { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } })
        })
        host = srv.host
    })

    after(async function() {
        await srv.close()
        restoreProxy()
        fs.rmSync(FD, { recursive: true, force: true })
    })

    beforeEach(function() {
        resetS()
        srv.requests.length = 0
        fc = installFakeClock(D1 + 2 * DAY + 12 * H)
        getOptReader.resetWarned()
    })

    afterEach(function() {
        fc.restore()
    })

    let mk = (extra = {}) => WDwdataDeribit({ minGapMs: 0, retryTimes: 1, ...extra, hostHistory: host, hostLive: host })
    let fresh = (name) => {
        let fd = path.join(FD, name)
        fs.rmSync(fd, { recursive: true, force: true })
        return fd
    }
    let idsIn = (a, b) => TRADES.filter((t) => t.timestamp >= a && t.timestamp < b).map((t) => t.trade_id)
    let filesIn = (fd) => {
        let r = []
        let walk = (d) => {
            if (!fs.existsSync(d)) {
                return
            }
            for (let n of fs.readdirSync(d)) {
                let p = path.join(d, n)
                fs.statSync(p).isDirectory() ? walk(p) : r.push(path.relative(fd, p).replace(/\\/g, '/'))
            }
        }
        walk(fd)
        return r.sort()
    }

    it('D1 downloadTrades: 依時間分頁、同毫秒者以編號去重、區間為半開、查詢參數正確', async function() {
        let wdd = mk()

        //單頁7筆 ⇒ 03-01之28筆須多頁; 同毫秒之5筆跨頁亦不重不漏
        let r = await wdd.downloadTrades('ETH', 'option', D1, D1 + DAY, { count: 7 })
        assert.deepStrictEqual(r.trades.map((t) => t.trade_id), idsIn(D1, D1 + DAY))
        assert.ok(r.trades.length === 28 && r.pages >= 4 && new Set(r.trades.map((t) => t.trade_id)).size === 28, `筆數或頁數不符 ${r.trades.length} ${r.pages}`)

        //查詢參數: 第1頁自起點、迄為tEnd−1、依時間遞增; 之後各頁自上一頁末筆之時刻起
        let qs = tradeQs()
        assert.ok(qs.length === r.pages && qs[0].get('currency') === 'ETH' && qs[0].get('kind') === 'option' && qs[0].get('start_timestamp') === String(D1) && qs[0].get('end_timestamp') === String(D1 + DAY - 1) && qs[0].get('count') === '7' && qs[0].get('sorting') === 'asc', `第1頁之查詢不符 ${qs[0]}`)
        assert.ok(qs.every((q) => q.get('end_timestamp') === String(D1 + DAY - 1)) && Number(qs[1].get('start_timestamp')) >= D1, '各頁之迄不符')

        //半開區間: 恰在迄點(03-02 00:00:00.000)之一筆不屬03-01, 而屬03-02(為其第一筆)
        assert.ok(!r.trades.some((t) => t.timestamp === D1 + DAY), '迄點之成交不應納入')
        let r2 = await wdd.downloadTrades('ETH', 'option', D1 + DAY, D1 + 2 * DAY, { count: 7 })
        assert.ok(r2.trades[0].timestamp === D1 + DAY && r2.trades.length === 18, `起點之成交應納入 ${r2.trades.length}`)

        //預設單頁10000筆: 一頁即完
        srv.requests.length = 0
        let r3 = await wdd.downloadTrades('ETH', 'option', D1, D1 + 3 * DAY)
        assert.ok(r3.pages === 1 && r3.trades.length === TRADES.length, '預設之單頁筆數不符')
        assert.ok(tradeQs()[0].get('count') === '10000', '預設count應為10000')

        //他幣別無資料 ⇒ 空(有效之回答)
        assert.deepStrictEqual((await wdd.downloadTrades('BTC', 'option', D1, D1 + DAY)).trades, [])

        //起迄可為數字字串
        assert.ok((await wdd.downloadTrades('ETH', 'option', String(D1), ` ${D1 + DAY} `)).trades.length === 28, '數字字串之起迄應可')
    })

    it('D2 downloadTrades: 同毫秒筆數達單頁上限而無從分頁即拋(kind為pagingLimit)、count無效改用預設、必須參數無效即拋且不送請求', async function() {
        let wdd = mk()

        //同一毫秒之筆數達單頁上限 ⇒ 無從以時刻續頁, 拋錯(帶kind, 不重試)
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', D1, D1 + DAY, { count: 3 }), (e) => /too many trades at one timestamp/.test(e.message) && e.kind === 'pagingLimit')

        //count無效(超過交易所上限、非整數、負數): 改用預設10000, 不拋; 數字字串可
        for (let bad of [20000, 0, -1, 1.5, 'abc', Infinity]) {
            srv.requests.length = 0
            let r = await wdd.downloadTrades('ETH', 'option', D1, D1 + DAY, { count: bad })
            assert.ok(r.trades.length === 28 && tradeQs()[0].get('count') === '10000', `count無效時應用預設 ${String(bad)}`)
        }
        srv.requests.length = 0
        await wdd.downloadTrades('ETH', 'option', D1, D1 + DAY, { count: '9' })
        assert.ok(tradeQs()[0].get('count') === '9', '數字字串之count應轉為數值')

        //必須參數無效: reject, 訊息不帶輸入值, 先於任何請求
        srv.requests.length = 0
        let secret = 'sec-ret-val'
        await assert.rejects(() => wdd.downloadTrades('', 'option', D1, D1 + DAY), (e) => e.message === 'invalid currency: must be a non-empty string')
        await assert.rejects(() => wdd.downloadTrades('ETH', 5, D1, D1 + DAY), (e) => e.message === 'invalid kind: must be a non-empty string')
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', secret, D1 + DAY), (e) => e.message === 'invalid tStart: must be a timestamp in milliseconds' && !e.message.includes(secret))
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', D1, null), (e) => e.message === 'invalid tEnd: must be a timestamp in milliseconds')
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', D1, D1), (e) => e.message === 'invalid tEnd: must be greater than tStart')
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', D1, D1 - 1), /invalid tEnd/)
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', true, D1 + 1), /invalid tStart/)
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', D1 + 0.5, D1 + 1), /invalid tStart/)
        assert.ok(srv.requests.length === 0, '必須參數無效時不應送請求')

        //回應缺trades: invalidResponse; 400: badRequest, 不重試
        S.shapeDays.add('2024-03-01')
        await assert.rejects(() => wdd.downloadTrades('ETH', 'option', D1, D1 + DAY), (e) => e.kind === 'invalidResponse' && e.httpStatus === 200)
        srv.requests.length = 0
        await assert.rejects(() => wdd.downloadTrades('ETH', 'bad', D1, D1 + DAY), (e) => e.kind === 'badRequest' && e.attempts === 1)
        assert.ok(srv.requests.length === 1, '400不應重試')
    })

    it('D2b downloadTrades: 整頁皆已見過而未達單頁上限且仍有後續(伺服器之異常回應)時前進1毫秒續頁, 不無窮重取', async function() {

        //腳本化之伺服器: 第1頁 [x1, x2](有後續)、第2頁自x2之時刻起仍回 [x2](已見過、有後續)、其後之頁自x2之時刻 + 1起回 [x3](無後續)
        let mkTrade = (id, ts) => ({ trade_id: id, timestamp: ts, instrument_name: 'ETH-8MAR24-3000-P', direction: 'buy', amount: 1, price: 0.01, iv: 50, index_price: 3300, mark_price: 0.01 })
        let x1 = mkTrade('X-1', D1 + 1000)
        let x2 = mkTrade('X-2', D1 + 2000)
        let x3 = mkTrade('X-3', D1 + 3000)
        let starts = []
        let s2 = await startServer((req, res, u) => {
            let st = Number(u.searchParams.get('start_timestamp'))
            starts.push(st)
            let r = null
            if (starts.length === 1) {
                r = { trades: [x1, x2], has_more: true }
            }
            else if (st <= x2.timestamp && starts.length < 6) {
                r = { trades: [x2], has_more: true }
            }
            else {
                r = { trades: [x3], has_more: false }
            }
            return sendJson(res, 200, { jsonrpc: '2.0', result: r })
        })
        try {
            let w = WDwdataDeribit({ minGapMs: 0, hostHistory: s2.host })
            let r = await w.downloadTrades('ETH', 'option', D1, D1 + DAY)
            assert.deepStrictEqual(r.trades.map((t) => t.trade_id), ['X-1', 'X-2', 'X-3'])
            assert.deepStrictEqual(starts, [D1, D1 + 2000, D1 + 2001], `各頁之起點不符 ${starts}`)
            assert.ok(r.pages === 3, '頁數不符')
        }
        finally {
            await s2.close()
        }
    })

    it('D3 saveTrades、readTrades、summarizeRange: 只存已完整之日、續傳不重抓、日終寬限、以使用端之日界取用', async function() {
        let fdTrades = fresh('D3')
        let evs = []
        let wdd = mk({ onTrace: (e) => evs.push(e) })

        //現在 = 03-03 12:00; 寬限10分 ⇒ 已完整之日至03-02(03-03尚未結束); 起日02-29(該日無成交)
        let r = await wdd.saveTrades('ETH', 'option', fdTrades, '2024-02-29')
        assert.deepStrictEqual(r.saved.map((x) => [x.day, x.n, x.dropped]), [['2024-02-29', 0, 0], ['2024-03-01', 28, 0], ['2024-03-02', 18, 0]])
        assert.ok(r.days === 3 && r.skipped === 0 && r.failed.length === 0 && r.halted === null, `回傳不符 ${JSON.stringify(r)}`)
        assert.deepStrictEqual(filesIn(fdTrades), ['2024/2024-02-29.csv.gz', '2024/2024-03-01.csv.gz', '2024/2024-03-02.csv.gz'])
        assert.deepStrictEqual(evs.filter((e) => e.type === 'day').map((e) => [e.day, e.state, e.n]), [['2024-02-29', 'saved', 0], ['2024-03-01', 'saved', 28], ['2024-03-02', 'saved', 18]])

        //檔案內容: gzip之CSV, 首列為欄名, 0筆之日只有欄名; 檔內之成交與正規化後之成交相同
        let text = zlib.gunzipSync(fs.readFileSync(fpOfDay(fdTrades, '2024-03-01'))).toString('utf8')
        let lines = text.split('\n')
        assert.ok(lines[0] === 'ts,id,name,dir,amount,price,iv,index,mark' && lines.length === 30 && lines[29] === '', `CSV之行數不符 ${lines.length}`)
        assert.ok(lines[1].startsWith(`${TRADES[0].timestamp},ETH-1000,ETH-8MAR24-3000-P,`), `首筆不符 ${lines[1]}`)
        assert.ok(zlib.gunzipSync(fs.readFileSync(fpOfDay(fdTrades, '2024-02-29'))).toString('utf8') === 'ts,id,name,dir,amount,price,iv,index,mark\n', '0筆之日應只有欄名')

        //0筆之日為已完整(有檔、非缺); 讀取時不列為缺
        let z = wdd.readTrades(fdTrades, D1 - DAY, D1)
        assert.ok(z.trades.length === 0 && z.missingDays.length === 0, '0筆之日應為已完整')

        //續傳: 已有檔之日不重抓(不送請求)
        srv.requests.length = 0
        evs.length = 0
        let r2 = await wdd.saveTrades('ETH', 'option', fdTrades, '2024-02-29')
        assert.ok(r2.skipped === 3 && r2.saved.length === 0 && srv.requests.length === 0, `續傳不應重抓 ${JSON.stringify(r2)}`)
        assert.deepStrictEqual(evs.filter((e) => e.type === 'day').map((e) => e.state), ['skipped', 'skipped', 'skipped'])

        //日終之寬限: 現在 = 03-04 00:05、寬限10分(預設)⇒ 03-03尚不算完整; 現在 = 03-04 00:10 ⇒ 完整
        fc.set(D1 + 3 * DAY + 300000)
        let r3 = await wdd.saveTrades('ETH', 'option', fdTrades, '2024-03-01')
        assert.ok(r3.days === 2 && r3.saved.length === 0 && r3.skipped === 2, `寬限不符 ${JSON.stringify(r3)}`)
        fc.set(D1 + 3 * DAY + 600000)
        let r4 = await wdd.saveTrades('ETH', 'option', fdTrades, '2024-03-01')
        assert.ok(r4.days === 3 && r4.saved.length === 1 && r4.saved[0].day === '2024-03-03' && r4.saved[0].n === 9, `寬限之界不符 ${JSON.stringify(r4)}`)

        //opt.timeGrace: 寬限可調(數字字串可); 無效改用預設
        //(下載器記得下一次請求可起始之時刻, 時鐘往回撥時須另建下載器)
        let wdd2 = mk()
        let fd2 = fresh('D3b')
        fc.set(D1 + DAY + 1000)
        assert.ok((await wdd2.saveTrades('ETH', 'option', fd2, '2024-03-01', { timeGrace: '1000' })).saved.length === 1, '寬限1000毫秒應已完整')
        let fd3 = fresh('D3c')
        let rg = await wdd2.saveTrades('ETH', 'option', fd3, '2024-03-01', { timeGrace: 'abc' })
        assert.ok(rg.days === 0, `寬限無效應改用預設10分 ${JSON.stringify(rg)}`)

        //opt.dayEnd: 範圍之迄(含)
        let fd4 = fresh('D3d')
        fc.set(D1 + 10 * DAY)
        let r5 = await wdd2.saveTrades('ETH', 'option', fd4, '2024-03-01', { dayEnd: '2024-03-02' })
        assert.deepStrictEqual(r5.saved.map((x) => x.day), ['2024-03-01', '2024-03-02'])
        assert.ok(r5.days === 2, '迄日(含)之範圍不符')

        //起日晚於迄日 ⇒ 空範圍
        let r6 = await wdd2.saveTrades('ETH', 'option', fd4, '2024-03-05', { dayEnd: '2024-03-02' })
        assert.ok(r6.days === 0 && r6.saved.length === 0, '起日晚於迄日應為空範圍')

        //以使用端之日界取用: 台北之03-02 = [03-01 16:00Z, 03-02 16:00Z), 跨兩個UTC日之檔
        fc.set(D1 + 2 * DAY + 12 * H)
        let a = D1 + 16 * H
        let b = a + DAY
        let rd = wdd.readTrades(fdTrades, a, b)
        assert.deepStrictEqual(rd.trades.map((t) => t.id), idsIn(a, b))
        assert.deepStrictEqual(rd.trades, TRADES.filter((t) => t.timestamp >= a && t.timestamp < b).map(normalizeTrade))
        assert.ok(rd.trades.length >= 10 && rd.trades.some((t) => t.ts < D1 + DAY) && rd.trades.some((t) => t.ts >= D1 + DAY), '取樣須跨兩個UTC日')

        //讀取亦為半開區間: 迄點取同毫秒5筆之時刻 ⇒ 該5筆不納入; 起點為同毫秒5筆之時刻 ⇒ 該5筆納入
        let cut = D1 + 14 * H + 777
        let rc = wdd.readTrades(fdTrades, D1, cut)
        assert.deepStrictEqual(rc.trades.map((t) => t.id), idsIn(D1, cut))
        assert.ok(TRADES.filter((t) => t.timestamp === cut).length === 5 && !rc.trades.some((t) => t.ts === cut) && rc.trades.length >= 5, '讀取之迄點不應納入')
        assert.ok(wdd.readTrades(fdTrades, cut, cut + 1).trades.length === 5, '讀取之起點應納入')

        //summarizeRange: 入格與略過之筆數合計 = 讀到之筆數; 取樣內含已過到期之合約(ETH-2MAR24於03-02 08:00Z到期)之成交 ⇒ 略過 >= 1
        let sm = wdd.summarizeRange(fdTrades, a, b)
        let want = aggregateTrades(rd.trades)
        assert.ok(sm.complete && sm.n === want.n && sm.skipped === want.skipped && sm.n + sm.skipped === rd.trades.length && sm.skipped >= 1 && sm.n >= 10, `彙整之筆數不符 ${sm.n} ${sm.skipped} ${rd.trades.length}`)
        assert.deepStrictEqual(sm.cells, want.cells)
        assert.ok(sm.summary.total > 0 && sm.summary.pcr > 0 && sm.summary.pcr < 1, '基本量不符')

        //口徑選項透傳給彙整
        let smStd = wdd.summarizeRange(fdTrades, a, b, { moneyness: 'std' })
        assert.deepStrictEqual(smStd.cells, aggregateTrades(rd.trades, { moneyness: 'std' }).cells)
        assert.throws(() => wdd.summarizeRange(fdTrades, a, b, { moneyness: 'delta' }), /invalid opt\.moneyness/)

        //範圍內有尚未下載之日 ⇒ 標示不完整
        let sm2 = wdd.summarizeRange(fdTrades, D1 + 5 * DAY + 16 * H, D1 + 6 * DAY + 16 * H)
        assert.ok(!sm2.complete && sm2.missingDays.length === 2 && sm2.n === 0 && sm2.missingDays[0] === '2024-03-06', `缺日之標示不符 ${JSON.stringify(sm2.missingDays)}`)

        //迄點恰在UTC日界: 迄點所屬之日(半開區間之外)不列為缺
        assert.deepStrictEqual(wdd.readTrades(fdTrades, D1 + 5 * DAY, D1 + 6 * DAY).missingDays, ['2024-03-06'])
        assert.deepStrictEqual(wdd.readTrades(fdTrades, D1 + 5 * DAY - 1, D1 + 5 * DAY).missingDays, ['2024-03-05'])
    })

    it('D4 saveTrades: 暫存檔不殘留、無效之成交丟棄並計入dropped、檔案損毀時讀取即拋', async function() {
        let fdTrades = fresh('D4')
        let wdd = mk()
        S.junk = true
        let r = await wdd.saveTrades('ETH', 'option', fdTrades, '2024-03-01', { dayEnd: '2024-03-01' })
        assert.deepStrictEqual(r.saved.map((x) => [x.day, x.n, x.dropped]), [['2024-03-01', 28, 1]])
        assert.deepStrictEqual(filesIn(fdTrades), ['2024/2024-03-01.csv.gz'], '不應殘留暫存檔')

        //寫檔失敗(年份夾之位置為檔案, 無法建夾)⇒ 非請求之錯誤照原樣reject(不列入failed), 且不留下任何檔
        S.junk = false
        let fd3 = fresh('D4c')
        fs.mkdirSync(fd3, { recursive: true })
        fs.writeFileSync(path.join(fd3, '2024'), 'x')
        await assert.rejects(() => wdd.saveTrades('ETH', 'option', fd3, '2024-03-01', { dayEnd: '2024-03-01' }), (e) => typeof e.kind !== 'string')
        assert.deepStrictEqual(filesIn(fd3), ['2024'], '寫檔失敗不應殘留暫存檔')

        //檔案損毀: 欄名不符、欄數不符、非gzip ⇒ 讀取即拋(訊息不帶內容與路徑)
        let fd5 = fresh('D4e')
        let put = (day, buf) => {
            let fp = fpOfDay(fd5, day)
            fs.mkdirSync(path.dirname(fp), { recursive: true })
            fs.writeFileSync(fp, buf)
        }
        put('2024-03-01', zlib.gzipSync(Buffer.from('a,b\n1,2\n')))
        assert.throws(() => wdd.readTrades(fd5, D1, D1 + 1), (e) => e.message === 'invalid trade file: unexpected header')
        put('2024-03-01', zlib.gzipSync(Buffer.from('ts,id,name,dir,amount,price,iv,index,mark\n1,a\n')))
        assert.throws(() => wdd.readTrades(fd5, D1, D1 + 1), (e) => e.message === 'invalid trade file: unexpected row')
        put('2024-03-01', Buffer.from('not gzip'))
        assert.throws(() => wdd.readTrades(fd5, D1, D1 + 1), (e) => !e.message.includes('2024-03-01'))
    })

    it('D5 saveTrades之失敗與停止: 失敗之日不寫檔; 維護或流量限制用盡即停止, 未送者為notRequested; 連續連線層失敗達netFailTimes即停止; 其餘失敗不停止; 恢復後只補未完成之日', async function() {
        let wdd = mk()
        let evs = []
        let wdt = mk({ onTrace: (e) => evs.push(e) })

        //維護(503): 停止本次之後續請求, 未送者列為notRequested; 失敗之日不寫檔
        let fd2 = fresh('D5a')
        S.badDays = new Set(['2024-03-02'])
        fc.set(D1 + 3 * DAY + 12 * H)
        let f = await wdt.saveTrades('ETH', 'option', fd2, '2024-03-01')
        assert.deepStrictEqual(f.saved.map((x) => x.day), ['2024-03-01'])
        assert.deepStrictEqual(f.failed.map((x) => [x.day, x.kind, x.attempts]), [['2024-03-02', 'maintenance', 2], ['2024-03-03', 'notRequested', 0]])
        assert.ok(f.halted === 'maintenance' && !fs.existsSync(fpOfDay(fd2, '2024-03-02')) && !fs.existsSync(fpOfDay(fd2, '2024-03-03')), '失敗之日不應有檔')
        assert.deepStrictEqual(evs.filter((e) => e.type === 'halt').map((e) => [e.day, e.reason]), [['2024-03-02', 'maintenance']])
        assert.deepStrictEqual(evs.filter((e) => e.type === 'day').map((e) => [e.day, e.state, e.kind]), [['2024-03-01', 'saved', null], ['2024-03-02', 'failed', 'maintenance'], ['2024-03-03', 'notRequested', 'notRequested']])

        //恢復後再跑: 只補未完成之日
        S.badDays = new Set()
        let f2 = await wdd.saveTrades('ETH', 'option', fd2, '2024-03-01')
        assert.deepStrictEqual(f2.saved.map((x) => [x.day, x.n]), [['2024-03-02', 18], ['2024-03-03', 9]])
        assert.ok(f2.skipped === 1 && f2.failed.length === 0 && f2.halted === null, '補抓之回傳不符')

        //流量限制(429)用盡重試 ⇒ 停止
        let fd3 = fresh('D5b')
        S.limitDays = new Set(['2024-03-01'])
        let g = await wdd.saveTrades('ETH', 'option', fd3, '2024-03-01')
        assert.deepStrictEqual(g.failed.map((x) => [x.day, x.kind]), [['2024-03-01', 'rateLimited'], ['2024-03-02', 'notRequested'], ['2024-03-03', 'notRequested']])
        assert.ok(g.halted === 'rateLimited' && g.saved.length === 0, `流量限制之處置不符 ${JSON.stringify(g)}`)

        //連線層失敗: 連續netFailTimes日才停止, 中間有成功者歸零
        S.limitDays = new Set()
        let fd4 = fresh('D5c')
        S.netDays = new Set(['2024-02-27', '2024-02-29', '2024-03-01'])
        let n = await mk({ retryTimes: 0 }).saveTrades('ETH', 'option', fd4, '2024-02-27', { netFailTimes: 2 })
        assert.deepStrictEqual(n.failed.map((x) => [x.day, x.kind, x.attempts]), [['2024-02-27', 'network', 1], ['2024-02-29', 'network', 1], ['2024-03-01', 'network', 1], ['2024-03-02', 'notRequested', 0], ['2024-03-03', 'notRequested', 0]])
        assert.deepStrictEqual(n.saved.map((x) => x.day), ['2024-02-28'])
        assert.ok(n.halted === 'network', '連續2日連線層失敗應停止')

        //netFailTimes為0: 不停止
        let fd5 = fresh('D5d')
        S.netDays = new Set(['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01'])
        let n0 = await mk({ retryTimes: 0 }).saveTrades('ETH', 'option', fd5, '2024-02-27', { netFailTimes: 0 })
        assert.ok(n0.halted === null && n0.failed.length === 4 && n0.saved.map((x) => x.day).join() === '2024-03-02,2024-03-03', `netFailTimes為0不應停止 ${JSON.stringify(n0)}`)

        //預設netFailTimes為3: 連續2日失敗不停止, 第3日起停止
        let fd6 = fresh('D5e')
        S.netDays = new Set(['2024-02-27', '2024-02-28'])
        let nd = await mk({ retryTimes: 0 }).saveTrades('ETH', 'option', fd6, '2024-02-27')
        assert.ok(nd.halted === null && nd.failed.length === 2 && nd.saved.length === 4, '連續2日失敗不應停止')
        let fd7 = fresh('D5f')
        S.netDays = new Set(['2024-02-27', '2024-02-28', '2024-02-29'])
        let nd3 = await mk({ retryTimes: 0 }).saveTrades('ETH', 'option', fd7, '2024-02-27')
        assert.ok(nd3.halted === 'network' && nd3.failed.length === 6 && nd3.failed.filter((x) => x.kind === 'notRequested').length === 3 && nd3.saved.length === 0, '連續3日失敗應停止')

        //5xx用盡、回應格式不符、同毫秒筆數達單頁上限: 列入failed而不停止, 下一日照常
        let fd8 = fresh('D5g')
        S.netDays = new Set()
        S.errDays = new Set(['2024-03-01'])
        S.shapeDays = new Set(['2024-03-02'])
        let m = await wdd.saveTrades('ETH', 'option', fd8, '2024-03-01')
        assert.deepStrictEqual(m.failed.map((x) => [x.day, x.kind, x.httpStatus, x.attempts]), [['2024-03-01', 'httpError', 500, 2], ['2024-03-02', 'invalidResponse', 200, 1]])
        assert.ok(m.halted === null && m.saved.map((x) => x.day).join() === '2024-03-03', `5xx與格式不符不應停止 ${JSON.stringify(m)}`)
        let fd9 = fresh('D5h')
        S.errDays = new Set()
        S.shapeDays = new Set()
        let pg = await wdd.saveTrades('ETH', 'option', fd9, '2024-03-01', { count: 3 })
        assert.deepStrictEqual(pg.failed.map((x) => [x.day, x.kind, x.attempts]), [['2024-03-01', 'pagingLimit', 0]])
        assert.ok(pg.halted === null && pg.saved.map((x) => x.day).join() === '2024-03-02,2024-03-03' && !fs.existsSync(fpOfDay(fd9, '2024-03-01')), `pagingLimit之處置不符 ${JSON.stringify(pg)}`)

        //400(種類不被接受): 列入failed、不重試
        srv.requests.length = 0
        let fd10 = fresh('D5i')
        let bad = await wdd.saveTrades('ETH', 'bad', fd10, '2024-03-01', { dayEnd: '2024-03-01' })
        assert.ok(bad.failed.length === 1 && bad.failed[0].kind === 'badRequest' && bad.failed[0].attempts === 1 && srv.requests.length === 1 && bad.halted === null, `400之處置不符 ${JSON.stringify(bad)}`)
    })

    it('D6 saveTrades之必須參數與選項: 無效即reject(先於任何請求與寫檔), 訊息不帶輸入值', async function() {
        let fd = fresh('D6')
        let wdd = mk()
        let secret = 'sec-ret-val'
        let bad = async (args, msg) => {
            await assert.rejects(() => wdd.saveTrades(...args), (e) => e.message === msg && !e.message.includes(secret))
        }
        await bad(['', 'option', fd, '2024-03-01'], 'invalid currency: must be a non-empty string')
        await bad(['ETH', undefined, fd, '2024-03-01'], 'invalid kind: must be a non-empty string')
        await bad(['ETH', 'option', 5, '2024-03-01'], 'invalid fdTrades: must be a non-empty string')
        await bad(['ETH', 'option', 'a\0b', '2024-03-01'], 'invalid fdTrades: must be a non-empty string')
        await bad(['ETH', 'option', fd, secret], 'invalid dayStart: must be a day string in YYYY-MM-DD')
        await bad(['ETH', 'option', fd, '2024-3-1'], 'invalid dayStart: must be a day string in YYYY-MM-DD')
        await bad(['ETH', 'option', fd, '2024-02-30'], 'invalid dayStart: must be a day string in YYYY-MM-DD')
        await bad(['ETH', 'option', fd, undefined], 'invalid dayStart: must be a day string in YYYY-MM-DD')

        //dayEnd決定下載之範圍: 給了而無效即拋, 不改用預設; undefined與null為未給
        await bad(['ETH', 'option', fd, '2024-03-01', { dayEnd: secret }], 'invalid opt.dayEnd: must be a day string in YYYY-MM-DD')
        await bad(['ETH', 'option', fd, '2024-03-01', { dayEnd: 20240301 }], 'invalid opt.dayEnd: must be a day string in YYYY-MM-DD')
        assert.ok(srv.requests.length === 0 && !fs.existsSync(fd), '必須參數無效時不應送請求或建夾')
        assert.ok((await wdd.saveTrades('ETH', 'option', fd, '2024-03-01', { dayEnd: null })).saved.length === 2, 'dayEnd為null應視為未給')
        assert.ok((await wdd.saveTrades('ETH', 'option', fd, '2024-03-01', null)).skipped === 2, 'opt為null應視為未給')
        assert.ok((await wdd.saveTrades('ETH', 'option', fd, '2024-03-01')).skipped === 2, 'opt未給應可')

        //readTrades之必須參數
        assert.throws(() => wdd.readTrades('', D1, D1 + 1), /invalid fdTrades/)
        assert.throws(() => wdd.readTrades(fd, 'x', D1 + 1), /invalid tStart/)
        assert.throws(() => wdd.readTrades(fd, D1, D1), (e) => e.message === 'invalid tEnd: must be greater than tStart')
        assert.throws(() => wdd.summarizeRange(fd, D1, D1 - 1), /invalid tEnd/)
    })

    it('D7 並行與觀察: 同一下載器之並行saveTrades共用節流, 事件與回傳一致, 請求數累計', async function() {
        let fdA = fresh('D7a')
        let fdB = fresh('D7b')
        let evs = []
        let wdd = mk({ minGapMs: 220, onTrace: (e) => evs.push(e) })
        fc.set(D1 + 5 * DAY)
        let [ra, rb] = await Promise.all([
            wdd.saveTrades('ETH', 'option', fdA, '2024-03-01', { dayEnd: '2024-03-01' }),
            wdd.saveTrades('ETH', 'option', fdB, '2024-03-02', { dayEnd: '2024-03-03' }),
        ])
        assert.ok(ra.saved.length === 1 && ra.saved[0].n === 28 && rb.saved.length === 2 && rb.saved[0].n === 18 && rb.saved[1].n === 9, `並行之回傳不符 ${JSON.stringify([ra, rb])}`)
        assert.ok(wdd.stats.requests === 3 && srv.requests.length === 3, `請求數不符 ${wdd.stats.requests} ${srv.requests.length}`)

        //3次請求(共用同一節流)之起始各相隔至少220: 第1次不等; 第2次(另一呼叫之首次)等220; 第3次(前一次完成後)距第2次之起始再等220 ⇒ 虛擬時鐘共前進440
        assert.deepStrictEqual(evs.filter((e) => e.type === 'throttle').map((e) => e.wait), [220, 220])
        assert.ok(fc.now() === D1 + 5 * DAY + 440, `虛擬時鐘應前進440 ${fc.now() - (D1 + 5 * DAY)}`)
        assert.ok(evs.filter((e) => e.type === 'attempt').every((e) => e.kind === 'ok'), '各次嘗試應皆成功')
    })

    it('D8 downloadVolIndex、saveVolIndex: 區間為半開[tStart, tEnd)、依continuation往前續頁、不重不漏、存成CSV、解析度之檢測', async function() {
        let wdd = mk()

        //區間為半開[tStart, tEnd): 恰在tStart之點入、恰在tEnd之點不入(假伺服器之迄為含, 故回應含恰在tEnd之點, 須由本端濾除);
        //交易所之迄仍送tEnd; 每次回應至多50點 ⇒ 回應共121點須3次請求, 保留120點
        let a = D1 + 10 * H
        let b = D1 + 130 * H
        assert.ok(DVOL.some((p) => p[0] === a) && DVOL.some((p) => p[0] === b), '夾具須有恰在起點與迄點之點')
        let d = await wdd.downloadVolIndex('ETH', a, b)
        assert.deepStrictEqual(d, DVOL.filter((p) => p[0] >= a && p[0] < b))
        assert.ok(d.length === 120 && d[0][0] === a && d[d.length - 1][0] === b - H && srv.requests.length === 3, `點數或請求數不符 ${d.length} ${srv.requests.length}`)
        let q0 = new URL(srv.requests[0].url, 'http://127.0.0.1').searchParams
        assert.ok(q0.get('currency') === 'ETH' && q0.get('resolution') === '3600' && q0.get('start_timestamp') === String(a) && q0.get('end_timestamp') === String(b), `第1次查詢不符 ${q0}`)
        let q1 = new URL(srv.requests[1].url, 'http://127.0.0.1').searchParams
        assert.ok(Number(q1.get('end_timestamp')) < b && q1.get('start_timestamp') === String(a), '續頁之迄應為continuation')

        //相鄰兩區間[a, m)與[m, b)之結果相接, 不重不漏(m上之點只屬後一區間)
        let m = D1 + 70 * H
        let dA = await wdd.downloadVolIndex('ETH', a, m)
        let dB = await wdd.downloadVolIndex('ETH', m, b)
        assert.ok(dA.length === 60 && dB.length === 60 && dA[dA.length - 1][0] === m - H && dB[0][0] === m, `相鄰區間之邊界不符 ${dA.length} ${dB.length}`)
        assert.deepStrictEqual([...dA, ...dB], d)
        assert.deepStrictEqual(await wdd.downloadVolIndex('ETH', m - H, m), [DVOL.find((p) => p[0] === m - H)], '恰在迄點之點不入, 恰在起點之點入')

        //起點晚於點1毫秒 ⇒ 該點不入; 迄點晚於點1毫秒 ⇒ 該點入
        assert.deepStrictEqual((await wdd.downloadVolIndex('ETH', a + 1, a + H + 1)).map((p) => p[0]), [a + H])
        assert.deepStrictEqual((await wdd.downloadVolIndex('ETH', a, a + 1)).map((p) => p[0]), [a])

        //存成CSV(欄: ts,open,high,low,close; 區間同上為半開, 末列為b - 1小時)
        let fp = path.join(fresh('D8'), 'ETH', 'volindex_3600.csv')
        let r = await wdd.saveVolIndex('ETH', fp, a, b)
        let lines = fs.readFileSync(fp, 'utf8').trim().split('\n')
        assert.ok(r.n === 120 && r.from === new Date(a).toISOString() && r.to === new Date(b - H).toISOString() && lines.length === 121 && lines[0] === 'ts,open,high,low,close' && lines[1] === d[0].join(',') && lines[120] === d[119].join(','), 'CSV不符')
        assert.deepStrictEqual(filesIn(path.dirname(path.dirname(fp))), ['ETH/volindex_3600.csv'], '不應殘留暫存檔')

        //相鄰兩區間各存一檔: 兩檔之資料列相接後與整段相同(邊界點不重複)
        let fpA = path.join(fresh('D8a'), 'a.csv')
        let fpB = path.join(fresh('D8c'), 'b.csv')
        await wdd.saveVolIndex('ETH', fpA, a, m)
        await wdd.saveVolIndex('ETH', fpB, m, b)
        let rowsOf = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').slice(1)
        assert.deepStrictEqual([...rowsOf(fpA), ...rowsOf(fpB)], lines.slice(1))

        //回應夾帶範圍外之點(起點之前、迄點之後)時濾除
        S.extra = true
        let d2 = await wdd.downloadVolIndex('ETH', a, b)
        S.extra = false
        assert.deepStrictEqual(d2, d)

        //continuation為尚未回傳之下一個較早之點之時刻本身(含): 該點不得漏
        S.contExact = true
        let d5 = await wdd.downloadVolIndex('ETH', a, b)
        S.contExact = false
        assert.deepStrictEqual(d5, d)

        //continuation與前一頁重疊(含上一頁最早之點)時依時刻去重; continuation不小於本次之迄時即停止(不無窮續頁)
        S.overlap = true
        let d3 = await wdd.downloadVolIndex('ETH', a, b)
        S.overlap = false
        assert.deepStrictEqual(d3, d)
        S.stuck = true
        srv.requests.length = 0
        let d4 = await wdd.downloadVolIndex('ETH', a, b)
        S.stuck = false
        assert.ok(srv.requests.length === 1 && d4.length === 49, `continuation不小於迄時應停止(單頁50點中恰在迄點者不入) ${srv.requests.length} ${d4.length}`)

        //範圍內無資料 ⇒ 只有欄名之檔, n為0
        let fp2 = path.join(fresh('D8b'), 'v.csv')
        let r2 = await wdd.saveVolIndex('ETH', fp2, D1 + 500 * H, D1 + 501 * H)
        assert.ok(r2.n === 0 && r2.from === null && r2.to === null && fs.readFileSync(fp2, 'utf8') === 'ts,open,high,low,close\n', '無資料之檔不符')

        //解析度: 預設3600; 可給秒數(數字或數字字串)與'1D'; 給了而無效即拋(不送請求)
        srv.requests.length = 0
        await wdd.downloadVolIndex('ETH', a, a + H, { resolution: 60 })
        await wdd.downloadVolIndex('ETH', a, a + H, { resolution: '43200' })
        await wdd.downloadVolIndex('ETH', a, a + H, { resolution: '1D' })
        await wdd.downloadVolIndex('ETH', a, a + H, { resolution: null })
        assert.deepStrictEqual(srv.requests.map((q) => new URL(q.url, 'http://127.0.0.1').searchParams.get('resolution')), ['60', '43200', '1D', '3600'])
        srv.requests.length = 0
        let secret = 'sec-ret-val'
        for (let bad of [secret, 0, -60, 1.5, '1d', true, {}]) {
            await assert.rejects(() => wdd.downloadVolIndex('ETH', a, a + H, { resolution: bad }), (e) => e.message === 'invalid opt.resolution: must be a positive integer in seconds or 1D' && !e.message.includes(secret))
        }
        assert.ok(srv.requests.length === 0, '解析度無效時不應送請求')

        //必須參數
        await assert.rejects(() => wdd.downloadVolIndex('', a, b), /invalid currency/)
        await assert.rejects(() => wdd.downloadVolIndex('ETH', b, a), (e) => e.message === 'invalid tEnd: must be greater than tStart')
        await assert.rejects(() => wdd.saveVolIndex('ETH', '', a, b), /invalid fp/)
        await assert.rejects(() => wdd.saveVolIndex('ETH', fp, 'x', b), /invalid tStart/)
    })

    it('D9 WDwdataDeribit之選項: 主機與代理決定下載來源與網路出口, 給了而無效即拋(不改用預設), 訊息不帶輸入值; 主機之尾端斜線與路徑', async function() {
        let secret = 'sec-ret-val'
        let bad = (o, msg) => assert.throws(() => WDwdataDeribit(o), (e) => e.message === msg && !e.message.includes(secret))
        let hostMsg = (k) => `invalid opt.${k}: must be an http(s) url without credentials, query or hash`
        let proxyMsg = 'invalid opt.proxy: must be an object { protocol, host, port, auth }'
        bad({ hostHistory: secret }, hostMsg('hostHistory'))
        bad({ hostHistory: 'history.deribit.com' }, hostMsg('hostHistory'))
        bad({ hostHistory: 'ftp://history.deribit.com' }, hostMsg('hostHistory'))
        bad({ hostHistory: 'https://u:p@history.deribit.com' }, hostMsg('hostHistory'))
        bad({ hostHistory: 'https://history.deribit.com/?a=1' }, hostMsg('hostHistory'))
        bad({ hostHistory: 'https://history.deribit.com/#x' }, hostMsg('hostHistory'))
        bad({ hostHistory: 5 }, hostMsg('hostHistory'))
        bad({ hostLive: '' }, hostMsg('hostLive'))
        bad({ proxy: secret }, proxyMsg)
        bad({ proxy: {} }, proxyMsg)
        bad({ proxy: { host: '127.0.0.1' } }, proxyMsg)
        bad({ proxy: { host: '127.0.0.1', port: 0 } }, proxyMsg)
        bad({ proxy: { host: '127.0.0.1', port: 70000 } }, proxyMsg)
        bad({ proxy: { host: 'a b', port: 8080 } }, proxyMsg)
        bad({ proxy: { host: '127.0.0.1', port: 8080, protocol: 'socks5' } }, proxyMsg)
        bad({ proxy: { host: '127.0.0.1', port: 8080, auth: { username: 'u' } } }, proxyMsg)
        bad({ proxy: { host: '127.0.0.1', port: 8080, auth: 'u:p' } }, proxyMsg)

        //有效者: undefined、null為未給; 代理之埠可為數字字串
        assert.ok(WDwdataDeribit({ hostHistory: undefined, hostLive: null, proxy: null }) && WDwdataDeribit(null) && WDwdataDeribit(), 'undefined與null應視為未給')
        assert.ok(WDwdataDeribit({ proxy: { protocol: 'https:', host: 'proxy.example', port: '8080', auth: { username: 'u', password: '' } } }), '有效之代理不符')

        //代理之物件不被改寫
        let px = { host: '127.0.0.1', port: '8080', protocol: 'http:' }
        WDwdataDeribit({ proxy: px })
        assert.deepStrictEqual(px, { host: '127.0.0.1', port: '8080', protocol: 'http:' })

        //主機之尾端斜線與路徑前綴: 請求之路徑為 <路徑前綴>/api/v2/public/...
        let wdd = WDwdataDeribit({ minGapMs: 0, hostHistory: `${host}/`, hostLive: `${host}///` })
        srv.requests.length = 0
        await wdd.downloadTrades('ETH', 'option', D1, D1 + 1)
        await wdd.downloadVolIndex('ETH', D1, D1 + H)
        assert.ok(srv.requests[0].url.startsWith('/api/v2/public/get_last_trades_by_currency_and_time?') && srv.requests[1].url.startsWith('/api/v2/public/get_volatility_index_data?'), `路徑不符 ${srv.requests.map((q) => q.url)}`)
        let p2 = WDwdataDeribit({ minGapMs: 0, hostHistory: `${host}/pre/fix/` })
        srv.requests.length = 0
        await assert.rejects(() => p2.downloadTrades('ETH', 'option', D1, D1 + 1), (e) => e.kind === 'httpError' && e.httpStatus === 404)
        assert.ok(srv.requests[0].url.startsWith('/pre/fix/api/v2/public/get_last_trades_by_currency_and_time?'), `路徑前綴不符 ${srv.requests[0].url}`)

        //debug: 請求端選項無效時警告, 不含輸入值
        let msgs = []
        WDwdataDeribit({ minGapMs: secret, debug: true, funLog: (m) => msgs.push(m) })
        assert.ok(msgs.length === 1 && msgs[0].includes('invalid opt.minGapMs') && !msgs[0].includes(secret), `警告不符 ${JSON.stringify(msgs)}`)
        assert.deepStrictEqual(Object.keys(wdd), ['downloadTrades', 'saveTrades', 'readTrades', 'summarizeRange', 'aggregateTrades', 'summarizeCells', 'parseInstrument', 'downloadVolIndex', 'saveVolIndex', 'stats'])
    })

    it('D10 歷史主機與即時主機: 逐筆成交(下載與逐日存檔)走hostHistory, 波動指數(下載與存檔)走hostLive(兩者各為獨立之伺服器)', async function() {
        fresh('D10t')
        let live = await startServer((req, res, u) => {
            if (u.pathname === '/api/v2/public/get_volatility_index_data') {
                return sendJson(res, 200, { jsonrpc: '2.0', result: { data: [[D1, 1, 2, 0.5, 1.5]], continuation: null } })
            }
            return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32601, message: 'x' } })
        })
        try {
            let wdd = WDwdataDeribit({ minGapMs: 0, hostHistory: host, hostLive: live.host })
            let t = await wdd.downloadTrades('ETH', 'option', D1, D1 + DAY)
            let v = await wdd.downloadVolIndex('ETH', D1, D1 + H)
            let fp = path.join(fresh('D10'), 'v.csv')
            await wdd.saveVolIndex('ETH', fp, D1, D1 + H)
            let sv = await wdd.saveTrades('ETH', 'option', path.join(FD, 'D10t'), '2024-03-01', { dayEnd: '2024-03-01' })
            assert.ok(t.trades.length === 28 && v.length === 1 && fs.readFileSync(fp, 'utf8').split('\n')[1] === `${D1},1,2,0.5,1.5` && sv.saved.length === 1 && sv.saved[0].n === 28, '各主機之回應不符')
            assert.ok(srv.requests.length === 2 && srv.requests.every((r) => r.url.includes('get_last_trades')) && live.requests.length === 2 && live.requests.every((r) => r.url.includes('get_volatility_index_data')), `請求之主機不符 ${srv.requests.length} ${live.requests.length}`)
            assert.ok(wdd.stats.requests === 4, '請求數應跨主機累計')
        }
        finally {
            await live.close()
        }
    })
})
