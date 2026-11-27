//w-dwdata-deribit: 請求端(節流、逾時、重試與分類、代理、觀察回調); 以本機假伺服器(只聽127.0.0.1之系統配發埠)與假時鐘核對, 等待以事件(onTrace)與假時鐘之sleeps核對, 不以實際延時
//逾時之案(Q8)為真實之計時器: 以伺服器端之連線關閉事件為同步點, 只斷言語意(分類為timeout), 不斷言耗時
import assert from 'assert'
import getOptReader from 'wsemi/src/getOptReader.mjs'
import { makeClient, classifyResult } from '../src/request.mjs'
import timers from '../src/timers.mjs'
import { installFakeClock } from './tools/fakeClock.mjs'
import { startServer, sendJson, withNoProxy } from './tools/fakeServer.mjs'


describe('api-request', function() {

    let srv = null
    let S = { plan: [] }
    let restoreProxy = null
    let fc = null
    let ok = (res) => sendJson(res, 200, { jsonrpc: '2.0', result: { v: 1 } })
    let ERR = (code) => ({ jsonrpc: '2.0', error: { code, message: 'x' } })

    before(async function() {
        restoreProxy = withNoProxy()
        srv = await startServer((req, res) => {
            let step = S.plan.length ? S.plan.shift() : null
            if (step === null) {
                return ok(res)
            }
            return step(req, res)
        })
    })

    after(async function() {
        await srv.close()
        restoreProxy()
    })

    beforeEach(function() {
        S.plan = []
        srv.requests.length = 0
        fc = installFakeClock()
        getOptReader.resetWarned()
    })

    afterEach(function() {
        fc.restore()
    })

    let plan = (...codes) => {
        for (let c of codes) {
            S.plan.push((req, res) => sendJson(res, c, ERR(13028)))
        }
    }
    let url = () => `${srv.host}/api/v2/public/x`
    let kinds = (evs) => evs.filter((e) => e.type === 'attempt').map((e) => [e.attempt, e.kind, e.httpStatus])
    let waits = (evs) => evs.filter((e) => e.type === 'retry').map((e) => [e.attempt, e.wait, e.kind])

    it('Q1 classifyResult: 各種結果之分類與是否重試', function() {
        let c = (status, json, extra = {}) => classifyResult({ status, json, err: null, aborted: false, ...extra })
        let want = (r, kind, retry) => assert.ok(r.kind === kind && r.retry === retry, `分類不符 ${JSON.stringify(r)} 應為 ${kind} ${retry}`)
        want(c(200, { result: { a: 1 } }), 'ok', false)
        want(c(200, { result: 0 }), 'ok', false)
        want(c(200, { result: false }), 'ok', false)
        want(c(200, { result: null }), 'invalidResponse', true)
        want(c(200, {}), 'invalidResponse', true)
        want(c(200, null), 'invalidResponse', true)
        want(c(204, null), 'invalidResponse', true)
        want(c(429, ERR(-1)), 'rateLimited', true)
        want(c(200, ERR(10028)), 'rateLimited', true)
        want(c(400, ERR(10028)), 'rateLimited', true)
        assert.ok(c(200, ERR(10028)).code === 10028 && c(500, ERR(-32000)).code === -32000 && c(500, null).code === null && c(500, ERR(1.5)).code === null, '錯誤代碼之取值不符')
        want(c(503, ERR(13028)), 'maintenance', true)
        want(c(400, ERR(-32602)), 'badRequest', false)
        want(c(404, null), 'httpError', false)
        want(c(401, null), 'httpError', false)
        want(c(301, null), 'httpError', false)
        want(c(500, null), 'httpError', true)
        want(c(502, null), 'httpError', true)
        want(c(504, null), 'httpError', true)
        let net = classifyResult({ status: null, json: null, err: new Error('x'), aborted: false })
        want(net, 'network', true)
        let to = classifyResult({ status: null, json: null, err: new Error('x'), aborted: true })
        want(to, 'timeout', true)
        assert.ok(net.httpStatus === null && to.httpStatus === null, '無回應者HTTP狀態應為null')
    })

    it('Q2 重試: 503兩次後成功, 事件為三次嘗試與兩次等待(1、3秒), 以假時鐘之sleeps核對, 不實際等待', async function() {
        let evs = []
        let c = makeClient({ minGapMs: 0, onTrace: (e) => evs.push(e) })
        plan(503, 503)
        let r = await c.getResult(url(), { a: 1 })
        assert.deepStrictEqual(r, { v: 1 })
        assert.deepStrictEqual(kinds(evs), [[1, 'maintenance', 503], [2, 'maintenance', 503], [3, 'ok', 200]])
        assert.deepStrictEqual(waits(evs), [[1, 1000, 'maintenance'], [2, 3000, 'maintenance']])
        assert.deepStrictEqual(fc.sleeps, [1000, 3000])
        assert.ok(c.stats.requests === 3 && srv.requests.length === 3, `請求數不符 ${c.stats.requests} ${srv.requests.length}`)

        //查詢參數與標頭
        assert.ok(srv.requests[0].url === '/api/v2/public/x?a=1' && srv.requests[0].headers.accept === 'application/json', `請求不符 ${srv.requests[0].url}`)
    })

    it('Q3 重試用盡: 預設重試3次(共4次嘗試, 等待1、3、9秒), 失敗物件帶kind、狀態、代碼、嘗試次數, 訊息不帶網址與參數', async function() {
        let evs = []
        let c = makeClient({ minGapMs: 0, onTrace: (e) => evs.push(e) })
        plan(503, 503, 503, 503, 503)
        await assert.rejects(() => c.getResult(url(), { secretParam: 'sec-ret-123' }), (e) => {
            return e.kind === 'maintenance' && e.httpStatus === 503 && e.code === 13028 && e.attempts === 4 && e.message === 'request failed: kind[maintenance] status[503] attempts[4]' && !/127\.0\.0\.1|sec-ret/.test(e.message)
        })
        assert.deepStrictEqual(waits(evs).map((x) => x[1]), [1000, 3000, 9000])
        assert.deepStrictEqual(fc.sleeps, [1000, 3000, 9000])
        assert.ok(srv.requests.length === 4, '應送出4次請求')

        //retryTimes為0 ⇒ 不重試; 等待之上限timeRetryMax
        S.plan = []
        plan(503, 503, 503, 503)
        let c0 = makeClient({ minGapMs: 0, retryTimes: 0 })
        await assert.rejects(() => c0.getResult(url(), {}), (e) => e.attempts === 1)
        S.plan = []
        plan(503, 503, 503, 503)
        let evs2 = []
        fc.sleeps.length = 0
        let c1 = makeClient({ minGapMs: 0, timeRetryMax: 2500, onTrace: (e) => evs2.push(e) })
        await assert.rejects(() => c1.getResult(url(), {}), (e) => e.attempts === 4)
        assert.deepStrictEqual(waits(evs2).map((x) => x[1]), [1000, 2500, 2500])
    })

    it('Q4 分類: 400與404與3xx不重試(3xx不跟隨), 429與流量限制代碼(含HTTP 200)與5xx與非JSON之2xx重試', async function() {

        //400: 不重試
        let c = makeClient({ minGapMs: 0 })
        plan(400)
        await assert.rejects(() => c.getResult(url(), {}), (e) => e.kind === 'badRequest' && e.attempts === 1)
        assert.ok(srv.requests.length === 1, '400不應重試')

        //404、301: 不重試; 301不跟隨(只送一次請求)
        S.plan.push((req, res) => sendJson(res, 404, ERR(-32601)))
        await assert.rejects(() => c.getResult(url(), {}), (e) => e.kind === 'httpError' && e.httpStatus === 404 && e.attempts === 1)
        S.plan.push((req, res) => {
            res.writeHead(301, { Location: `${srv.host}/other` })
            res.end()
        })
        await assert.rejects(() => c.getResult(url(), {}), (e) => e.kind === 'httpError' && e.httpStatus === 301 && e.attempts === 1)
        assert.ok(srv.requests.length === 3 && srv.requests.every((q) => q.url.startsWith('/api/')), '3xx不應被跟隨')

        //429: 重試後成功
        let evs = []
        let c2 = makeClient({ minGapMs: 0, onTrace: (e) => evs.push(e) })
        plan(429)
        assert.deepStrictEqual(await c2.getResult(url(), {}), { v: 1 })
        assert.deepStrictEqual(kinds(evs), [[1, 'rateLimited', 429], [2, 'ok', 200]])

        //HTTP 200而為流量限制之錯誤代碼10028: 視為rateLimited並重試
        evs.length = 0
        S.plan.push((req, res) => sendJson(res, 200, ERR(10028)))
        assert.deepStrictEqual(await c2.getResult(url(), {}), { v: 1 })
        assert.deepStrictEqual(kinds(evs), [[1, 'rateLimited', 200], [2, 'ok', 200]])

        //500: 重試; HTTP 200之HTML頁面(如代理之頁面): 重試
        evs.length = 0
        plan(500)
        S.plan.push((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html>proxy page</html>')
        })
        assert.deepStrictEqual(await c2.getResult(url(), {}), { v: 1 })
        assert.deepStrictEqual(kinds(evs), [[1, 'httpError', 500], [2, 'invalidResponse', 200], [3, 'ok', 200]])

        //重試用盡之invalidResponse: 失敗物件之kind
        let c3 = makeClient({ minGapMs: 0, retryTimes: 1 })
        for (let i = 0; i < 2; i++) {
            S.plan.push((req, res) => sendJson(res, 200, { jsonrpc: '2.0' }))
        }
        await assert.rejects(() => c3.getResult(url(), {}), (e) => e.kind === 'invalidResponse' && e.httpStatus === 200 && e.attempts === 2)
    })

    it('Q5 節流: 相鄰兩次請求之起始至少相隔minGapMs; 並行呼叫共用同一節流(以throttle事件與sleeps核對)', async function() {
        let evs = []
        let c = makeClient({ onTrace: (e) => evs.push(e) })

        //預設220毫秒; 依序三次: 第1次不等, 其後各等220
        await c.getResult(url(), {})
        await c.getResult(url(), {})
        await c.getResult(url(), {})
        assert.deepStrictEqual(evs.filter((e) => e.type === 'throttle').map((e) => e.wait), [220, 220])
        assert.deepStrictEqual(fc.sleeps, [220, 220])

        //並行三次(同一請求端): 起始時刻依序為0、220、440之後
        evs.length = 0
        fc.sleeps.length = 0
        let c2 = makeClient({ minGapMs: 300, onTrace: (e) => evs.push(e) })
        await Promise.all([c2.getResult(url(), {}), c2.getResult(url(), {}), c2.getResult(url(), {})])
        assert.deepStrictEqual(evs.filter((e) => e.type === 'throttle').map((e) => e.wait).sort((a, b) => a - b), [300, 600])
        assert.ok(c2.stats.requests === 3, '請求數不符')

        //minGapMs為0 ⇒ 不節流; 各請求端獨立
        evs.length = 0
        let c3 = makeClient({ minGapMs: 0, onTrace: (e) => evs.push(e) })
        await c3.getResult(url(), {})
        await c3.getResult(url(), {})
        assert.ok(evs.filter((e) => e.type === 'throttle').length === 0, 'minGapMs為0不應節流')

        //節流之間隔以單調時鐘計, 不受牆上時鐘被往回撥之影響
        evs.length = 0
        let c4 = makeClient({ minGapMs: 220, onTrace: (e) => evs.push(e) })
        await c4.getResult(url(), {})
        timers.now = () => 5
        await c4.getResult(url(), {})
        assert.deepStrictEqual(evs.filter((e) => e.type === 'throttle').map((e) => e.wait), [220])
    })

    it('Q6 選項: 給了而無效改用預設(不拋), 數字字串轉為數值, debug時警告且不含輸入值', async function() {
        let msgs = []
        let evs = []
        let secret = 'sec-ret-xyz'

        //retryTimes、timeRetry無效 ⇒ 預設3次、1000; 警告帶程式常數而不帶值
        let c = makeClient({ minGapMs: 0, retryTimes: secret, timeRetry: Infinity, timeRetryMax: -1, timeRequest: 0, debug: true, funLog: (m) => msgs.push(m), onTrace: (e) => evs.push(e) })
        plan(503, 503, 503, 503)
        await assert.rejects(() => c.getResult(url(), {}), (e) => e.attempts === 4)
        assert.deepStrictEqual(waits(evs).map((x) => x[1]), [1000, 3000, 9000])
        assert.ok(msgs.length === 4 && msgs.every((m) => m.startsWith('[w-dwdata-deribit request] invalid opt.') && !m.includes(secret)), `警告不符 ${JSON.stringify(msgs)}`)
        assert.ok(msgs.some((m) => m.includes('invalid opt.retryTimes: must be a non-negative integer, using default 3')), '警告之內容不符')

        //數字字串(含頭尾空白)轉為數值: retryTimes '1' ⇒ 共2次嘗試; timeRetry ' 5 ' ⇒ 等待5
        let evs2 = []
        let c2 = makeClient({ minGapMs: '0', retryTimes: '1', timeRetry: ' 5 ', onTrace: (e) => evs2.push(e) })
        S.plan = []
        plan(503, 503, 503)
        await assert.rejects(() => c2.getResult(url(), {}), (e) => e.attempts === 2)
        assert.deepStrictEqual(waits(evs2).map((x) => x[1]), [5])

        //'-0'為有效整數, 轉為0(不為-0): 重試等待之事件為0
        let evs3 = []
        let c3 = makeClient({ minGapMs: 0, retryTimes: 1, timeRetry: '-0', onTrace: (e) => evs3.push(e) })
        S.plan = []
        plan(503, 503)
        await assert.rejects(() => c3.getResult(url(), {}), (e) => e.attempts === 2)
        assert.ok(waits(evs3).length === 1 && Object.is(waits(evs3)[0][1], 0), `等待應為0 ${JSON.stringify(waits(evs3))}`)

        //未開debug: 不警告; undefined與null視為未給; opt為null、不可讀之Proxy皆不拋
        msgs.length = 0
        makeClient({ retryTimes: 'x', funLog: (m) => msgs.push(m) })
        assert.ok(msgs.length === 0, '未開debug不應警告')
        assert.ok(makeClient({ retryTimes: undefined, timeRetry: null }) && makeClient(null) && makeClient(), 'undefined、null應視為未給')
        let pr = Proxy.revocable({}, {})
        pr.revoke()
        assert.ok(makeClient(pr.proxy), '不可讀之opt應視為未給')
    })

    it('Q7 onTrace: 事件凍結、回調拋錯或回傳rejection皆不影響請求、未給或非函數時照常運作', async function() {
        let evs = []
        let c = makeClient({ minGapMs: 0, onTrace: (e) => evs.push(e) })
        await c.getResult(url(), {})
        assert.ok(evs.length === 1 && evs[0].type === 'attempt' && Object.isFrozen(evs[0]), '事件應為凍結之物件')
        assert.throws(() => {
            evs[0].kind = 'x' //ES模組為嚴格模式, 改寫凍結之物件即拋TypeError
        }, TypeError)

        //回調拋錯
        let thrower = () => {
            throw new Error('x')
        }
        let c2 = makeClient({ minGapMs: 0, onTrace: thrower })
        plan(503)
        assert.deepStrictEqual(await c2.getResult(url(), {}), { v: 1 })

        //回調回傳rejection: 不產生未處理之rejection
        let un = []
        let h = (err) => un.push(err)
        process.on('unhandledRejection', h)
        let c3 = makeClient({ minGapMs: 0, onTrace: () => Promise.reject(new Error('x')) })
        assert.deepStrictEqual(await c3.getResult(url(), {}), { v: 1 })
        await new Promise((resolve) => setImmediate(resolve))
        process.off('unhandledRejection', h)
        assert.ok(un.length === 0, '回調之rejection應被忽略')

        //未給或非函數
        assert.deepStrictEqual(await makeClient({ minGapMs: 0 }).getResult(url(), {}), { v: 1 })
        assert.deepStrictEqual(await makeClient({ minGapMs: 0, onTrace: 'x' }).getResult(url(), {}), { v: 1 })
    })

    it('Q8 逾時: 單一請求超過timeRequest即中止並分類為timeout(重試); 以伺服器已收到請求為同步點, 於假時鐘觸發逾時, 不以實際延時', async function() {

        //伺服器收到請求後不回應(hang); nSeen為已收到之請求數, waitSeen(n)等到至少收到n個請求
        let closed = []
        let nSeen = 0
        let waiters = []
        let hang = (req, res) => {
            closed.push(new Promise((resolve) => {
                req.on('close', resolve)
            }))
            nSeen++
            for (let w of waiters.splice(0)) {
                w()
            }
        }
        let waitSeen = (n) => new Promise((resolve) => {
            let chk = () => {
                if (nSeen >= n) {
                    resolve()
                }
                else {
                    waiters.push(chk)
                }
            }
            chk()
        })
        S.plan.push(hang, hang)
        let evs = []
        let c = makeClient({ minGapMs: 0, timeRequest: 30, retryTimes: 1, timeRetry: 7, onTrace: (e) => evs.push(e) })
        let done = assert.rejects(c.getResult(url(), {}), (e) => e.kind === 'timeout' && e.httpStatus === null && e.attempts === 2)

        //第1次請求: 已送出且逾時之計時器已登記, 於(虛擬)時鐘觸發逾時
        await waitSeen(1)
        assert.deepStrictEqual(fc.pendingDelays(), [30], '送出之請求應登記一個逾時之計時器(timeRequest毫秒)')
        fc.fireTimeouts()

        //重試之等待後第2次請求
        await waitSeen(2)
        assert.deepStrictEqual(fc.pendingDelays(), [30], '重試之請求應登記一個逾時之計時器(timeRequest毫秒)')
        fc.fireTimeouts()
        await done
        assert.deepStrictEqual(kinds(evs), [[1, 'timeout', null], [2, 'timeout', null]])
        assert.deepStrictEqual(waits(evs), [[1, 7, 'timeout']])
        assert.ok(fc.pendingTimeouts() === 0, '結束後不應殘留逾時之計時器')

        //伺服器端確實觀察到連線被中止(防懸置上限用真實計時器)
        let guard = new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('server did not observe the abort')), 10000).unref()
        })
        await Promise.race([Promise.all(closed), guard])
        assert.ok(closed.length === 2, '應有2次請求被中止')

        //請求成功時取消逾時之計時器
        let c2 = makeClient({ minGapMs: 0 })
        assert.deepStrictEqual(await c2.getResult(url(), {}), { v: 1 })
        assert.ok(fc.pendingTimeouts() === 0, '成功後不應殘留逾時之計時器')
    })

    it('Q9 連線錯誤: 無回應者分類為network(重試)', async function() {
        let s2 = await startServer(() => {})
        let dead = s2.host
        await s2.close()
        let evs = []
        let c = makeClient({ minGapMs: 0, retryTimes: 2, timeRetry: 1, onTrace: (e) => evs.push(e) })
        await assert.rejects(() => c.getResult(`${dead}/api/v2/public/x`, {}), (e) => e.kind === 'network' && e.httpStatus === null && e.attempts === 3 && !/127\.0\.0\.1/.test(e.message))
        assert.deepStrictEqual(kinds(evs).map((x) => x[1]), ['network', 'network', 'network'])
        assert.deepStrictEqual(waits(evs).map((x) => x[1]), [1, 3])
    })

    it('Q10 代理: 給了proxy即經代理送出(絕對網址與Proxy-Authorization), 未經代理時不帶', async function() {
        let seen = []
        let px = await startServer((req, res) => {
            seen.push({ url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] || null })
            sendJson(res, 200, { jsonrpc: '2.0', result: { via: 'proxy' } })
        })
        try {
            let c = makeClient({ minGapMs: 0 }, { protocol: 'http', host: '127.0.0.1', port: px.port, auth: { username: 'u', password: 'p' } })
            let r = await c.getResult('http://deribit-proxy-test.invalid/api/v2/public/x', { a: 1, b: 'q w' })
            assert.deepStrictEqual(r, { via: 'proxy' })
            assert.ok(seen.length === 1 && seen[0].url.startsWith('http://deribit-proxy-test.invalid/api/v2/public/x?a=1&b=q') && seen[0].host === 'deribit-proxy-test.invalid', `代理收到之請求不符 ${JSON.stringify(seen)}`)
            assert.ok(seen[0].auth === `Basic ${Buffer.from('u:p').toString('base64')}`, `Proxy-Authorization不符 ${seen[0].auth}`)
        }
        finally {
            await px.close()
        }

        //未給proxy: 直連, 不經代理
        let before = srv.requests.length
        assert.deepStrictEqual(await makeClient({ minGapMs: 0 }).getResult(url(), {}), { v: 1 })
        assert.ok(srv.requests.length === before + 1 && seen.length === 1, '未給proxy應直連')
    })

    it('Q11 預設之時鐘: now為牆上時鐘、mono為單調時鐘、sleep為真實之計時器(還原假時鐘後)', async function() {
        fc.restore()
        assert.ok(Math.abs(timers.now() - Date.now()) < 1000, 'now應為牆上時鐘')
        let m1 = timers.mono()
        let m2 = timers.mono()
        assert.ok(Number.isFinite(m1) && m2 >= m1, 'mono應為單調')
        let t0 = timers.mono()
        await timers.sleep(5)
        assert.ok(timers.mono() - t0 >= 4, 'sleep應真的等待')

        //timeout與cancel: 到期呼叫fn, 取消者不呼叫(以事件為同步點, 不斷言耗時)
        let fired = await new Promise((resolve) => {
            timers.timeout(() => resolve('fired'), 1)
        })
        assert.ok(fired === 'fired', 'timeout到期應呼叫fn')
        let called = 0
        let h = timers.timeout(() => {
            called++
        }, 1)
        timers.cancel(h)
        await timers.sleep(10)
        assert.ok(called === 0, '取消之計時器不應呼叫fn')
    })
})
