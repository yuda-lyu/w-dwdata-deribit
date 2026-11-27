import getOptReader from 'wsemi/src/getOptReader.mjs'
import { fail, toNum, readStrict, isPosNum } from './opts.mjs'
import { parseInstrument } from './trades.mjs'


//選擇權成交之彙整(純函式): 逐筆成交 → 格(買賣權 × 主動買賣 × 價性級 × 距到期日數級) → 每日之基本量
//格之值 = [口數, 權利金, Σ(隱含波動率 × 口數), 有隱含波動率之口數, 筆數], 故買賣權比、主動買賣差、偏斜、期限結構等皆可由格重組

const DAY = 86400000

//價性之界 'pct': ln(履約價 ÷ 指數價): < −20%、−20 ~ −10%、−10 ~ −5%、−5 ~ −2%、±2% 內、2 ~ 5%、5 ~ 10%、10 ~ 20%、≥ 20%
const M_EDGES_PCT = [-0.20, -0.10, -0.05, -0.02, 0.02, 0.05, 0.10, 0.20]

//'std': ln(履約價 ÷ 指數價)÷(隱含波動率 × √(距到期年數)), 即以該筆之隱含波動率與剩餘時間標準化(同一級於高低波動時代表相近之價外程度)
const M_EDGES_STD = [-2, -1, -0.5, -0.2, 0.2, 0.5, 1, 2]

//距到期日數之界: < 1、1 ~ 3、3 ~ 7、7 ~ 14、14 ~ 30、30 ~ 60、60 ~ 120、≥ 120
const D_EDGES = [1, 3, 7, 14, 30, 60, 120]

const KEY_REG = /^[CP][BS]\|\d+\|\d+$/


//binOf, x落在界edges之第幾級(x < edges[0] ⇒ 0; x ≥ 末界 ⇒ edges.length; 恰在界上歸較高之級)
let binOf = (x, edges) => {
    let k = 0
    while (k < edges.length && x >= edges[k]) {
        k++
    }
    return k
}


//readCfg, 彙整之口徑選項(決定格之歸屬與權利金之意義, 給了而無效即拋, 不改用預設)
let readCfg = (opt) => {
    let rd = getOptReader('w-dwdata-deribit aggregateTrades', opt)
    let moneyness = readStrict(rd, 'moneyness', 'pct', (v) => v === 'pct' || v === 'std', 'one of pct, std')
    let priceInCoin = readStrict(rd, 'priceInCoin', true, (v) => typeof v === 'boolean', 'a boolean')
    let minDte = readStrict(rd, 'minDte', 1 / 24, isPosNum, 'a positive number')
    return { moneyness, priceInCoin, minDte: toNum(minDte) }
}


//keyWith, 以已檢測之口徑決定一筆成交所屬之格之鍵, 無從歸格者回null
let keyWith = (t, cfg) => {
    if (!t || typeof t !== 'object') {
        return null
    }
    let ins = parseInstrument(t.name)
    if (!ins || !(t.index > 0) || !(t.amount > 0) || !(ins.strike > 0) || (t.dir !== 'buy' && t.dir !== 'sell')) {
        return null
    }
    let dte = (ins.expiry - t.ts) / DAY
    if (!(dte >= 0)) {
        return null
    }
    let m = Math.log(ins.strike / t.index)
    let edges = M_EDGES_PCT
    if (cfg.moneyness === 'std') {
        if (!(t.iv > 0)) {
            return null
        }
        m = m / ((t.iv / 100) * Math.sqrt(Math.max(dte, cfg.minDte) / 365))
        edges = M_EDGES_STD
    }
    return `${ins.type}${t.dir === 'buy' ? 'B' : 'S'}|${binOf(m, edges)}|${binOf(dte, D_EDGES)}`
}


/**
 * 一筆成交所屬之格之鍵 `${C|P}${B|S}|${價性級}|${日數級}`(C買權、P賣權；B主動買、S主動賣)。
 * 無從歸格者回null：合約名不合、指數價或口數非正、已過到期、主動方不明；'std'另須有正之隱含波動率。
 * 口徑選項(moneyness、minDte)決定格之歸屬，給了而無效即拋(訊息為'invalid opt.<名稱>: must be <種類>'，不帶輸入值)。
 *
 * @function cellKeyOf
 * @param {Object} t - 正規化後之成交 { ts, name, dir, amount, price, iv, index }
 * @param {Object} [opt={}] - 設定參數
 * @param {String} [opt.moneyness='pct'] - 價性之口徑：'pct'(ln(履約價 ÷ 指數價)之固定界)或'std'(再除以該筆之隱含波動率 × √距到期年數)
 * @param {Number} [opt.minDte=1/24] - 'std'之距到期日數下限(正數，避免到期前一刻之值發散)
 * @returns {String|null} 格之鍵，無從歸格者為null
 */
let cellKeyOf = (t, opt = {}) => {
    return keyWith(t, readCfg(opt))
}


/**
 * 一批成交 → 格。
 *
 * @function aggregateTrades
 * @param {Array} trades - 正規化後之成交(readTrades之trades)
 * @param {Object} [opt={}] - 設定參數，口徑選項給了而無效即拋
 * @param {String} [opt.moneyness='pct'] - 價性之口徑，見cellKeyOf
 * @param {Number} [opt.minDte=1/24] - 'std'之距到期日數下限，見cellKeyOf
 * @param {Boolean} [opt.priceInCoin=true] - 權利金之報價是否以標的幣計：true(反向合約)⇒權利金(美元) = 價 × 指數價 × 口數；false ⇒ 價 × 口數
 * @returns {Object} 回傳物件 { n(入格之筆數), skipped(無從歸格者之筆數), cells: { 鍵: [口數, 權利金, Σ iv × 口數, 有iv之口數, 筆數] } }
 */
let aggregateTrades = (trades, opt = {}) => {
    if (!Array.isArray(trades)) {
        fail('trades', 'an array')
    }
    let cfg = readCfg(opt)
    let cells = {}
    let n = 0
    let skipped = 0
    for (let t of trades) {
        let key = keyWith(t, cfg)
        if (!key) {
            skipped++
            continue
        }
        let c = cells[key] || (cells[key] = [0, 0, 0, 0, 0])
        c[0] += t.amount
        c[1] += (t.price > 0 ? t.price : 0) * (cfg.priceInCoin ? t.index : 1) * t.amount
        if (t.iv > 0) {
            c[2] += t.iv * t.amount
            c[3] += t.amount
        }
        c[4]++
        n++
    }
    return { n, skipped, cells }
}


//cellSum, 格依條件加總: pick(type, dir, m, d)為真者之 [口數, 權利金, Σ iv × 口數, 有iv之口數]
let cellSum = (cells, pick) => {
    let s = [0, 0, 0, 0]
    for (let key of Object.keys(cells)) {
        let p = key.split('|')
        if (pick(key[0], key[1], Number(p[1]), Number(p[2]))) {
            let c = cells[key]
            s[0] += c[0]
            s[1] += c[1]
            s[2] += c[2]
            s[3] += c[3]
        }
    }
    return s
}


/**
 * 格 → 基本量(分母為0者NaN)：
 * total總口數；pcr賣權口數比；pcrPrem賣權權利金比；netCall、netPut買權、賣權之主動買賣差÷其口數；
 * bullFlow(買權淨買 − 賣權淨買)÷總口數，bullFlowPrem其權利金版；skew價外賣權(價性第1、2級)− 價外買權(第6、7級)之隱含波動率(日數級3 ~ 5)；
 * atmIv價平(價性第3 ~ 5級；日數級3 ~ 5)之隱含波動率；term短(日數級1、2)− 長(5、6)之價平隱含波動率；
 * shortShare日數級 ≤ 1之口數占比；otmCallShare買權價性第6級以上之占比；otmPutShare賣權價性第2級以下之占比。
 * 隱含波動率為各格以口數加權之平均(只計有隱含波動率之口數)。cells須為aggregateTrades回傳之cells形式，格式不符即拋。
 *
 * @function summarizeCells
 * @param {Object} cells - aggregateTrades回傳之cells
 * @returns {Object} 回傳物件 { total, pcr, pcrPrem, netCall, netPut, bullFlow, bullFlowPrem, skew, atmIv, term, shortShare, otmCallShare, otmPutShare }，分母為0者為NaN
 */
let summarizeCells = (cells) => {
    //cells可為空物件(無成交), 故不用iseobj
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) {
        fail('cells', 'an object of cells')
    }
    for (let key of Object.keys(cells)) {
        let c = cells[key]
        if (!KEY_REG.test(key) || !Array.isArray(c) || c.length < 4 || !c.slice(0, 4).every((x) => Number.isFinite(x))) {
            fail('cells', 'an object of cells')
        }
    }
    let div = (a, b) => (b > 0 ? a / b : NaN)
    let iv = (s) => div(s[2], s[3])
    let all = cellSum(cells, () => true)
    let call = cellSum(cells, (t) => t === 'C')
    let put = cellSum(cells, (t) => t === 'P')
    let cb = cellSum(cells, (t, d) => t === 'C' && d === 'B')
    let cs = cellSum(cells, (t, d) => t === 'C' && d === 'S')
    let pb = cellSum(cells, (t, d) => t === 'P' && d === 'B')
    let ps = cellSum(cells, (t, d) => t === 'P' && d === 'S')
    let mid = (d) => d >= 3 && d <= 5
    let atm = (m) => m >= 3 && m <= 5
    return {
        total: all[0],
        pcr: div(put[0], all[0]),
        pcrPrem: div(put[1], all[1]),
        netCall: div(cb[0] - cs[0], call[0]),
        netPut: div(pb[0] - ps[0], put[0]),
        bullFlow: div((cb[0] - cs[0]) - (pb[0] - ps[0]), all[0]),
        bullFlowPrem: div((cb[1] - cs[1]) - (pb[1] - ps[1]), all[1]),
        skew: iv(cellSum(cells, (t, _, m, d) => t === 'P' && (m === 1 || m === 2) && mid(d))) - iv(cellSum(cells, (t, _, m, d) => t === 'C' && (m === 6 || m === 7) && mid(d))),
        atmIv: iv(cellSum(cells, (_, __, m, d) => atm(m) && mid(d))),
        term: iv(cellSum(cells, (_, __, m, d) => atm(m) && (d === 1 || d === 2))) - iv(cellSum(cells, (_, __, m, d) => atm(m) && (d === 5 || d === 6))),
        shortShare: div(cellSum(cells, (_, __, m, d) => d <= 1)[0], all[0]),
        otmCallShare: div(cellSum(cells, (t, _, m) => t === 'C' && m >= 6)[0], all[0]),
        otmPutShare: div(cellSum(cells, (t, _, m) => t === 'P' && m <= 2)[0], all[0]),
    }
}


export { M_EDGES_PCT, M_EDGES_STD, D_EDGES, binOf, cellKeyOf, aggregateTrades, cellSum, summarizeCells }
