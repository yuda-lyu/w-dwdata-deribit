//變異驗證(測試輔助): 於src之鏡像副本逐一植入單點缺陷, 跑測試, 看是否轉紅(殺死)
//執行: node test/tools/mutants.mjs --out <輸出資料夾> [--only <id,id,...>]
//  輸出資料夾須位於本套件之樹下(如 ./tmp/mut), 使鏡像副本內之測試以向上解析找到 node_modules(副本不建目錄連結、不複製 node_modules)
//  不改動套件內任何檔案; 錨點(find)須在該檔恰出現一次, 否則該項為ANCHOR-FAIL(不得靜默略過); 每次改碼後須重跑全部變異
//  判定: 殺死(KILLED) = 測試離開碼非0且輸出有passing或failing之摘要行; 存活(SURVIVED) = 全綠; 未判定(UNDECIDED) = 無摘要行(如逾時、崩潰)
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'


let ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let MOCHA = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js')

//變異表: { id, file, find, replace, note }
let M = [
    //request.mjs
    { id: 'R01', file: 'src/request.mjs', find: `if (s === 429 || code === 10028) {`, replace: `if (s === 429) {`, note: '流量限制代碼10028(HTTP 200)不歸rateLimited' },
    { id: 'R02', file: 'src/request.mjs', find: `if (s === 503) {`, replace: `if (s === 5030) {`, note: '503不歸maintenance' },
    { id: 'R03', file: 'src/request.mjs', find: `return { kind: 'badRequest', httpStatus: s, code, retry: false }`, replace: `return { kind: 'badRequest', httpStatus: s, code, retry: true }`, note: '400重試' },
    { id: 'R04', file: 'src/request.mjs', find: `retry: s >= 500 }`, replace: `retry: s >= 400 }`, note: '4xx重試' },
    { id: 'R05', file: 'src/request.mjs', find: `kind: r.aborted ? 'timeout' : 'network'`, replace: `kind: 'network'`, note: '逾時歸為network' },
    { id: 'R06', file: 'src/request.mjs', find: `3 ** (i - 1)`, replace: `3 ** i`, note: '退避之次方' },
    { id: 'R07', file: 'src/request.mjs', find: `Math.min(timeRetry * (3 ** (i - 1)), timeRetryMax)`, replace: `Math.max(timeRetry * (3 ** (i - 1)), timeRetryMax)`, note: '退避之上限' },
    { id: 'R08', file: 'src/request.mjs', find: `i >= retryTimes`, replace: `i > retryTimes`, note: '重試次數多一次' },
    { id: 'R09', file: 'src/request.mjs', find: `nextSlot = at + minGapMs`, replace: `nextSlot = at`, note: '節流之間隔' },
    { id: 'R10', file: 'src/request.mjs', find: `let now = timers.mono()`, replace: `let now = timers.now()`, note: '節流改用牆上時鐘' },
    { id: 'R11', file: 'src/request.mjs', find: `'minGapMs', 220,`, replace: `'minGapMs', 0,`, note: '預設節流' },
    { id: 'R12', file: 'src/request.mjs', find: `'retryTimes', 3,`, replace: `'retryTimes', 2,`, note: '預設重試次數' },
    { id: 'R13', file: 'src/request.mjs', find: `'timeRetry', 1000,`, replace: `'timeRetry', 500,`, note: '預設退避基數' },
    { id: 'R14', file: 'src/request.mjs', find: `maxRedirects: 0,`, replace: `maxRedirects: 5,`, note: '跟隨轉址' },
    { id: 'R15', file: 'src/request.mjs', find: `if (proxy) {`, replace: `if (false) {`, note: '不傳代理' },
    { id: 'R16', file: 'src/request.mjs', find: `stats.requests++`, replace: `stats.requests += 0`, note: '請求數不累計' },
    { id: 'R17', file: 'src/request.mjs', find: `i + 1}]`, replace: `i}]`, note: '失敗訊息之嘗試次數' },
    { id: 'R18', file: 'src/request.mjs', find: `e.code = c.code`, replace: `e.code = null`, note: '失敗物件之代碼' },
    { id: 'R19', file: 'src/request.mjs', find: `if (j && j.result !== undefined && j.result !== null) {`, replace: `if (j && j.result !== undefined) {`, note: 'result為null視為ok' },
    { id: 'R20', file: 'src/request.mjs', find: `ac.abort()`, replace: `0`, note: '逾時不中止請求' },
    { id: 'R21', file: 'src/request.mjs', find: `timers.cancel(timer)`, replace: `0`, note: '請求結束不取消逾時之計時器' },
    { id: 'R22', file: 'src/request.mjs', find: `signal: ac.signal,`, replace: ``, note: '請求不帶中止訊號' },
    { id: 'R23', file: 'src/request.mjs', find: `}, timeRequest)`, replace: `}, timeRequest + 1)`, note: '逾時之毫秒數多1(登記之到期時刻不符)' },

    //trades.mjs
    { id: 'T01', file: 'src/trades.mjs', find: `if (!seen.has(t.trade_id)) {`, replace: `if (true) {`, note: '不以編號去重' },
    { id: 'T02', file: 'src/trades.mjs', find: `let endInc = b - 1`, replace: `let endInc = b`, note: '迄點納入' },
    { id: 'T03', file: 'src/trades.mjs', find: `!(t.timestamp >= a && t.timestamp <= endInc)`, replace: `!(t.timestamp > a && t.timestamp <= endInc)`, note: '起點不納入' },
    { id: 'T04', file: 'src/trades.mjs', find: `            cur = last\n`, replace: `            cur = last + 1\n`, note: '下一頁自末筆時刻之後起(同毫秒者漏)' },
    { id: 'T05', file: 'src/trades.mjs', find: `res.trades.length >= count`, replace: `res.trades.length > count`, note: '單頁上限之判定' },
    { id: 'T06', file: 'src/trades.mjs', find: `e.kind = 'pagingLimit'`, replace: `e.kind = 'paging'`, note: 'pagingLimit之kind' },
    { id: 'T07', file: 'src/trades.mjs', find: `if (fs.existsSync(fp)) {`, replace: `if (false) {`, note: '已有檔仍重抓' },
    { id: 'T08', file: 'src/trades.mjs', find: `Math.floor((now - timeGrace) / DAY)`, replace: `Math.floor(now / DAY)`, note: '日終不計寬限' },
    { id: 'T09', file: 'src/trades.mjs', find: `* DAY - DAY\n`, replace: `* DAY\n`, note: '含未結束之日' },
    { id: 'T10', file: 'src/trades.mjs', find: `if (e.kind === 'maintenance' || e.kind === 'rateLimited') {`, replace: `if (e.kind === 'maintenance') {`, note: '流量限制不停止' },
    { id: 'T11', file: 'src/trades.mjs', find: `pages: d.pages })\n            netFails = 0`, replace: `pages: d.pages })`, note: '成功不歸零連線失敗數' },
    { id: 'T12', file: 'src/trades.mjs', find: `netFails >= netFailTimes`, replace: `netFails > netFailTimes`, note: '連線失敗之停止門檻' },
    { id: 'T13', file: 'src/trades.mjs', find: `netFailTimes > 0 && `, replace: ``, note: 'netFailTimes為0仍停止' },
    { id: 'T14', file: 'src/trades.mjs', find: `if (r.halted) {\n            r.failed.push`, replace: `if (false) {\n            r.failed.push`, note: '停止後仍送請求' },
    { id: 'T15', file: 'src/trades.mjs', find: `r.ts < b)`, replace: `r.ts <= b)`, note: '讀取迄點納入' },
    { id: 'T16', file: 'src/trades.mjs', find: `r.ts >= a &&`, replace: `r.ts > a &&`, note: '讀取起點不納入' },
    { id: 'T17', file: 'src/trades.mjs', find: `missingDays.push(day)`, replace: `0`, note: '缺日不列' },
    { id: 'T18', file: 'src/trades.mjs', find: `t < b; t += DAY`, replace: `t <= b; t += DAY`, note: '讀取多讀迄點所屬之日' },
    { id: 'T19', file: 'src/trades.mjs', find: `/[,\\r\\n]/.test(id)`, replace: `/[\\r\\n]/.test(id)`, note: '編號含逗號者不丟棄' },
    { id: 'T20', file: 'src/trades.mjs', find: `p.length !== COLS.length`, replace: `p.length < COLS.length`, note: '欄數過多不拋' },
    { id: 'T21', file: 'src/trades.mjs', find: `!Array.isArray(res.trades)`, replace: `false`, note: '回應缺trades不拋invalidResponse' },
    { id: 'T22', file: 'src/trades.mjs', find: `if (!res.has_more || res.trades.length === 0) {`, replace: `if (res.trades.length === 0) {`, note: '不依has_more結束' },
    { id: 'T23', file: 'src/trades.mjs', find: `cur = last + 1\n        }\n        else {`, replace: `cur = last\n        }\n        else {`, note: '整頁已見過時不前進1毫秒' },
    { id: 'T24', file: 'src/trades.mjs', find: `'timeGrace', 600000,`, replace: `'timeGrace', 0,`, note: '預設寬限' },
    { id: 'T25', file: 'src/trades.mjs', find: `'netFailTimes', 3,`, replace: `'netFailTimes', 2,`, note: '預設netFailTimes' },
    { id: 'T26', file: 'src/trades.mjs', find: `dayEnd === null ? lastDone : Math.min(`, replace: `dayEnd === null ? lastDone : Math.max(`, note: '迄日可超過已完整之日' },
    { id: 'T27', file: 'src/trades.mjs', find: `direction === 'buy' || t.direction === 'sell' ? t.direction : null`, replace: `t.direction`, note: '主動方不明者不歸null' },
    { id: 'T28', file: 'src/trades.mjs', find: `fs.renameSync(tmp, fp)`, replace: `fs.copyFileSync(tmp, fp)`, note: '改名改為複製(暫存檔殘留)' },

    //aggregate.mjs
    { id: 'A01', file: 'src/aggregate.mjs', find: `x >= edges[k]`, replace: `x > edges[k]`, note: '恰在界上歸較低之級' },
    { id: 'A02', file: 'src/aggregate.mjs', find: `!(dte >= 0)`, replace: `!(dte > 0)`, note: '到期當刻不入格' },
    { id: 'A03', file: 'src/aggregate.mjs', find: `Math.max(dte, cfg.minDte)`, replace: `Math.min(dte, cfg.minDte)`, note: '距到期日數之下限' },
    { id: 'A04', file: 'src/aggregate.mjs', find: `(cfg.priceInCoin ? t.index : 1)`, replace: `(cfg.priceInCoin ? 1 : t.index)`, note: '權利金之幣別換算反向' },
    { id: 'A05', file: 'src/aggregate.mjs', find: `if (t.iv > 0) {`, replace: `if (t.iv >= 0) {`, note: '無iv者入加權' },
    { id: 'A06', file: 'src/aggregate.mjs', find: `(t.price > 0 ? t.price : 0)`, replace: `t.price`, note: '價非正者不歸0' },
    { id: 'A07', file: 'src/aggregate.mjs', find: `if (!(t.iv > 0)) {`, replace: `if (false) {`, note: `'std'不要求iv` },
    { id: 'A08', file: 'src/aggregate.mjs', find: `t === 'P' && (m === 1 || m === 2) && mid(d))) - iv(`, replace: `t === 'P' && (m === 1 || m === 2) && mid(d))) + iv(`, note: '偏斜之號' },
    { id: 'A09', file: 'src/aggregate.mjs', find: `let div = (a, b) => (b > 0 ? a / b : NaN)`, replace: `let div = (a, b) => (b >= 0 ? a / b : NaN)`, note: '分母為0不為NaN' },
    { id: 'A10', file: 'src/aggregate.mjs', find: `!KEY_REG.test(key) || `, replace: ``, note: '格之鍵不檢測' },
    { id: 'A11', file: 'src/aggregate.mjs', find: `(v) => v === 'pct' || v === 'std'`, replace: `(v) => true`, note: 'moneyness不檢測' },
    { id: 'A12', file: 'src/aggregate.mjs', find: `(v) => typeof v === 'boolean'`, replace: `(v) => true`, note: 'priceInCoin不檢測' },
    { id: 'A13', file: 'src/aggregate.mjs', find: `readStrict(rd, 'minDte', 1 / 24,`, replace: `readStrict(rd, 'minDte', 1 / 1440,`, note: '預設距到期日數下限' },
    { id: 'A14', file: 'src/aggregate.mjs', find: `(d === 1 || d === 2))) - iv(`, replace: `(d === 1 || d === 2))) + iv(`, note: '期限結構之號' },
    { id: 'A15', file: 'src/aggregate.mjs', find: `t === 'P' && m <= 2)[0]`, replace: `t === 'P' && m <= 1)[0]`, note: '價外賣權之級界' },

    //volIndex.mjs
    { id: 'V01', file: 'src/volIndex.mjs', find: `res.continuation >= end`, replace: `false`, note: 'continuation不前進時不停止' },
    { id: 'V02', file: 'src/volIndex.mjs', find: `p[0] >= a && p[0] < b`, replace: `p[0] >= a`, note: '不濾迄點與其後之點' },
    { id: 'V03', file: 'src/volIndex.mjs', find: `p[0] >= a && p[0] < b`, replace: `p[0] < b`, note: '不濾起點之前之點' },
    { id: 'V09', file: 'src/volIndex.mjs', find: `p[0] >= a && p[0] < b`, replace: `p[0] > a && p[0] < b`, note: '恰在起點之點不入' },
    { id: 'V10', file: 'src/volIndex.mjs', find: `p[0] >= a && p[0] < b`, replace: `p[0] >= a && p[0] <= b`, note: '改回含迄點(兩端皆含)' },
    { id: 'V11', file: 'src/volIndex.mjs', find: `p[0] >= a && p[0] < b`, replace: `p[0] >= a && p[0] < b - 1`, note: '迄點前1毫秒之點不入' },
    { id: 'V12', file: 'src/volIndex.mjs', find: `end_timestamp: end, resolution`, replace: `end_timestamp: end - 1, resolution`, note: '送交易所之迄少1毫秒(第1頁之請求不符)' },
    { id: 'V04', file: 'src/volIndex.mjs', find: `.sort((p, q) => p[0] - q[0])`, replace: ``, note: '不排序' },
    { id: 'V05', file: 'src/volIndex.mjs', find: `pts.set(p[0], p)`, replace: `pts.set(p[0] + pts.size / 1000, p)`, note: '不依時刻去重' },
    { id: 'V06', file: 'src/volIndex.mjs', find: `'resolution', 3600,`, replace: `'resolution', 60,`, note: '預設解析度' },
    { id: 'V07', file: 'src/volIndex.mjs', find: `v === '1D' || iseint`, replace: `iseint`, note: '1D解析度不被接受' },
    { id: 'V08', file: 'src/volIndex.mjs', find: `end = res.continuation`, replace: `end = res.continuation - 1`, note: '續頁之迄少1毫秒' },

    //WDwdataDeribit.mjs
    { id: 'W01', file: 'src/WDwdataDeribit.mjs', find: `complete: r.missingDays.length === 0`, replace: `complete: true`, note: '缺日不標不完整' },
    { id: 'W02', file: 'src/WDwdataDeribit.mjs', find: `downloadVolIndex(client, hostLive,`, replace: `downloadVolIndex(client, hostHistory,`, note: '波動指數走歷史主機' },
    { id: 'W03', file: 'src/WDwdataDeribit.mjs', find: `saveTrades(client, hostHistory,`, replace: `saveTrades(client, hostLive,`, note: '逐筆成交之存檔走即時主機' },
    { id: 'W04', file: 'src/WDwdataDeribit.mjs', find: `aggregateTrades(r.trades, optAgg)`, replace: `aggregateTrades(r.trades)`, note: '口徑選項不透傳' },
    { id: 'W05', file: 'src/WDwdataDeribit.mjs', find: `downloadTrades(client, hostHistory,`, replace: `downloadTrades(client, hostLive,`, note: '逐筆成交之下載走即時主機' },
    { id: 'W06', file: 'src/WDwdataDeribit.mjs', find: `saveVolIndex(client, hostLive,`, replace: `saveVolIndex(client, hostHistory,`, note: '波動指數之存檔走歷史主機' },

    //opts.mjs
    { id: 'O01', file: 'src/opts.mjs', find: ` || !iseint(port, { use: 'port' })) {`, replace: `) {`, note: '代理之埠不檢測' },
    { id: 'O02', file: 'src/opts.mjs', find: `u.username !== '' || u.password !== '' || `, replace: ``, note: '主機網址可帶帳密' },
    { id: 'O03', file: 'src/opts.mjs', find: ` || u.search !== '' || u.hash !== ''`, replace: ``, note: '主機網址可帶查詢與片段' },
    { id: 'O04', file: 'src/opts.mjs', find: `(u.protocol !== 'http:' && u.protocol !== 'https:') || `, replace: ``, note: '主機網址不限http(s)' },
    { id: 'O05', file: 'src/opts.mjs', find: `/^https?:?$/.test(protocol)`, replace: `true`, note: '代理協定不檢測' },
    { id: 'O06', file: 'src/opts.mjs', find: `.replace(/\\/+$/, '')`, replace: ``, note: '主機之尾端斜線不去除' },
    { id: 'O07', file: 'src/opts.mjs', find: `if (!(b > a)) {`, replace: `if (!(b >= a)) {`, note: '起訖相等不拋' },
    { id: 'O08', file: 'src/opts.mjs', find: `return n === 0 ? 0 : n`, replace: `return n`, note: '-0不歸0' },
]


let argOf = (k) => {
    let i = process.argv.indexOf(k)
    return i >= 0 ? process.argv[i + 1] : undefined
}

let out = argOf('--out')
if (!out) {
    console.log('usage: node test/tools/mutants.mjs --out <輸出資料夾(須在套件樹下)> [--only <id,id,...>]')
    process.exit(2)
}
out = path.resolve(out)
if (!out.startsWith(ROOT + path.sep) || !fs.existsSync(MOCHA)) {
    console.log('輸出資料夾須在套件之樹下, 且已安裝mocha')
    process.exit(2)
}
let only = argOf('--only') ? new Set(argOf('--only').split(',')) : null
let mirror = path.join(out, 'mirror')
fs.rmSync(mirror, { recursive: true, force: true })
fs.mkdirSync(mirror, { recursive: true })
for (let n of ['src', 'test', 'package.json']) {
    fs.cpSync(path.join(ROOT, n), path.join(mirror, n), { recursive: true, filter: (s) => !s.includes(`${path.sep}_tmp`) })
}
console.log(`mirror ${path.relative(ROOT, mirror)}`)

//run, 於鏡像跑全部測試, 回 { code, passing, failing }
let run = () => {
    let r = spawnSync(process.execPath, [MOCHA, '--no-parallel', 'test/*.test.mjs', '--timeout', '20000'], { cwd: mirror, encoding: 'utf8', windowsHide: true, timeout: 600000 })
    let txt = `${r.stdout || ''}\n${r.stderr || ''}`
    let p = /(\d+) passing/.exec(txt)
    let f = /(\d+) failing/.exec(txt)
    return { code: r.status, passing: p ? Number(p[1]) : 0, failing: f ? Number(f[1]) : 0 }
}

let base = run()
console.log(`baseline: code=${base.code} passing=${base.passing} failing=${base.failing}`)
if (base.code !== 0 || base.failing !== 0 || base.passing === 0) {
    console.log('baseline不全綠, 中止')
    process.exit(1)
}

let res = []
for (let m of M) {
    if (only && !only.has(m.id)) {
        continue
    }
    let fp = path.join(mirror, m.file)
    let orig = fs.readFileSync(fp, 'utf8')
    let crlf = orig.includes('\r\n')
    let find = crlf ? m.find.replace(/\n/g, '\r\n') : m.find
    let rep = crlf ? m.replace.replace(/\n/g, '\r\n') : m.replace
    let n = orig.split(find).length - 1
    if (n !== 1) {
        res.push({ id: m.id, status: 'ANCHOR-FAIL', note: `${m.note} (錨點出現${n}次)` })
        console.log(`${m.id} ANCHOR-FAIL x${n} ${m.note}`)
        continue
    }
    fs.writeFileSync(fp, orig.replace(find, () => rep), 'utf8')
    let r = run()
    fs.writeFileSync(fp, orig, 'utf8')
    let status = r.passing + r.failing === 0 ? 'UNDECIDED' : r.code !== 0 ? 'KILLED' : 'SURVIVED'
    res.push({ id: m.id, status, note: m.note, passing: r.passing, failing: r.failing })
    console.log(`${m.id} ${status} (passing ${r.passing}, failing ${r.failing}) ${m.note}`)
}

let cnt = (s) => res.filter((x) => x.status === s).length
console.log(`== 變異 ${res.length} 項: KILLED ${cnt('KILLED')}, SURVIVED ${cnt('SURVIVED')}, UNDECIDED ${cnt('UNDECIDED')}, ANCHOR-FAIL ${cnt('ANCHOR-FAIL')}`)
fs.writeFileSync(path.join(out, 'mutants.result.json'), JSON.stringify(res, null, 2), 'utf8')
process.exit(res.every((x) => x.status === 'KILLED') ? 0 : 1)
