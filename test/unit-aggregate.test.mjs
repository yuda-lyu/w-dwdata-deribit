//w-dwdata-deribit: 合約名之解析、成交之正規化與CSV、價性與日數之分級、格之彙整、基本量; 資料為手造(各值相異)
import assert from 'assert'
import { parseInstrument, normalizeTrade, csvOfTrades, tradesOfCsv, fpOfDay, isDayStr, tsOfDay } from '../src/trades.mjs'
import { M_EDGES_PCT, M_EDGES_STD, D_EDGES, binOf, cellKeyOf, aggregateTrades, cellSum, summarizeCells } from '../src/aggregate.mjs'


describe('unit-aggregate', function() {

    let near = (a, b) => Math.abs(a - b) < 1e-9
    let ts = Date.UTC(2023, 4, 30, 8)
    let mk = (name, dir, amount, price, iv, index = 2000, at = ts) => ({ ts: at, id: `${name}-${dir}-${amount}`, name, dir, amount, price, iv, index, mark: price })

    it('A1 parseInstrument、normalizeTrade: 合約名之解析與成交之正規化', function() {

        //到期日08:00 UTC; 履約價可帶小數(. 或d)
        let p = parseInstrument('ETH-9JUN23-1850-P')
        assert.ok(p.base === 'ETH' && p.expiry === Date.UTC(2023, 5, 9, 8) && p.strike === 1850 && p.type === 'P', `解析不符 ${JSON.stringify(p)}`)
        assert.ok(parseInstrument('ETH-27DEC24-2500.5-C').strike === 2500.5 && parseInstrument('XRP_USDC-27DEC24-0d5-C').strike === 0.5 && parseInstrument('XRP_USDC-27DEC24-0d5-C').base === 'XRP_USDC', '小數履約價不符')
        assert.ok(parseInstrument('ETH-27DEC24-2500-C').type === 'C' && parseInstrument('ETH-1JAN25-100-C').expiry === Date.UTC(2025, 0, 1, 8), '買權或日期不符')
        assert.ok(parseInstrument('ETH-PERPETUAL') === null && parseInstrument('ETH-9XXX23-1850-P') === null && parseInstrument(undefined) === null && parseInstrument(7) === null && parseInstrument('ETH-9JUN23-1850-X') === null, '不合之名稱應為null')

        //正規化: 欄名對應; 缺隱含波動率者為null; 主動方不明者dir為null; 缺時刻、編號或合約名者整筆為null
        let raw = { trade_seq: 5, trade_id: 'ETH-77', timestamp: ts + 123, tick_direction: 1, price: 0.0125, mark_price: 0.0121, iv: 61.5, instrument_name: 'ETH-9JUN23-1850-P', index_price: 1901.25, direction: 'buy', amount: 3.5 }
        assert.deepStrictEqual(normalizeTrade(raw), { ts: ts + 123, id: 'ETH-77', name: 'ETH-9JUN23-1850-P', dir: 'buy', amount: 3.5, price: 0.0125, iv: 61.5, index: 1901.25, mark: 0.0121 })
        let n2 = normalizeTrade({ ...raw, iv: undefined, direction: 'zero_minus' })
        assert.ok(n2.iv === null && n2.dir === null && n2.amount === 3.5, '缺欄之處置不符')
        assert.ok(normalizeTrade({ ...raw, trade_id: 12345 }).id === '12345', '數字編號應轉為字串')
        assert.ok(normalizeTrade({ ...raw, trade_id: undefined }) === null && normalizeTrade({ ...raw, timestamp: NaN }) === null && normalizeTrade({ ...raw, instrument_name: 7 }) === null && normalizeTrade(null) === null && normalizeTrade('x') === null, '缺必要欄者應為null')

        //編號或合約名含逗號、換行者無法存為CSV, 整筆為null
        assert.ok(normalizeTrade({ ...raw, trade_id: 'a,b' }) === null && normalizeTrade({ ...raw, trade_id: 'a\nb' }) === null && normalizeTrade({ ...raw, instrument_name: 'ETH,1' }) === null, '含逗號或換行者應為null')

    })

    it('A2 csvOfTrades、tradesOfCsv、fpOfDay、日字串: 每日檔之內容來回一致', function() {
        let rows = [
            { ts: ts + 1, id: 'ETH-1', name: 'ETH-9JUN23-1850-P', dir: 'buy', amount: 3.5, price: 0.0125, iv: 61.5, index: 1901.25, mark: 0.0121 },
            { ts: ts + 2, id: 'ETH-2', name: 'ETH-30JUN23-2300-C', dir: 'sell', amount: 12, price: 0.0005, iv: null, index: 1899.01, mark: null },
            { ts: ts + 2, id: 'ETH-3', name: 'ETH-9JUN23-1700-P', dir: null, amount: 0.1, price: 0.2, iv: 102.33, index: 1899.02, mark: 0.1987 },
        ]
        let text = csvOfTrades(rows)
        assert.ok(text.split('\n')[0] === 'ts,id,name,dir,amount,price,iv,index,mark' && text.split('\n').length === 5, 'CSV之欄名或列數不符')
        assert.deepStrictEqual(tradesOfCsv(text), rows)
        assert.deepStrictEqual(tradesOfCsv(csvOfTrades([])), [])
        assert.throws(() => tradesOfCsv('a,b,c\n1,2,3\n'), /unexpected header/)

        //列之欄數不符或時刻非數字: 檔案損毀, 拋錯且訊息不帶內容
        let head = 'ts,id,name,dir,amount,price,iv,index,mark\n'
        assert.throws(() => tradesOfCsv(`${head}1,ETH-1,ETH-9JUN23-1850-P,buy,1,2,3\n`), (e) => /unexpected row/.test(e.message) && !/ETH-1/.test(e.message))
        assert.throws(() => tradesOfCsv(`${head}abc,ETH-1,ETH-9JUN23-1850-P,buy,1,2,3,4,5\n`), /unexpected row/)
        assert.throws(() => tradesOfCsv(`${head}1,ETH-1,ETH-9JUN23-1850-P,buy,1,2,3,4,5,6\n`), /unexpected row/)
        assert.ok(fpOfDay('/x/trades', '2024-03-01').replace(/\\/g, '/') === '/x/trades/2024/2024-03-01.csv.gz', `每日檔之路徑不符 ${fpOfDay('/x/trades', '2024-03-01')}`)

        //日字串: 須為真實存在之日期
        assert.ok(isDayStr('2024-02-29') && isDayStr('0001-01-01') && !isDayStr('2023-02-29') && !isDayStr('2024-3-1') && !isDayStr('2024-03-01 ') && !isDayStr(20240301) && !isDayStr('2024-13-01') && !isDayStr(undefined), '日字串之判定不符')
        assert.ok(tsOfDay('x', '2024-03-01') === Date.UTC(2024, 2, 1), '日之起點不符')
        assert.throws(() => tsOfDay('dayStart', '2024-02-30'), (e) => e.message === 'invalid dayStart: must be a day string in YYYY-MM-DD')
    })

    it('A3 binOf、cellKeyOf: 價性級(百分比與標準化)與日數級', function() {

        //恰在界上歸較高之級; 最低級0、最高級=界數
        assert.ok(binOf(-0.3, M_EDGES_PCT) === 0 && binOf(-0.20, M_EDGES_PCT) === 1 && binOf(0, M_EDGES_PCT) === 4 && binOf(0.02, M_EDGES_PCT) === 5 && binOf(0.5, M_EDGES_PCT) === 8, '價性級不符')
        assert.ok(binOf(0.5, D_EDGES) === 0 && binOf(1, D_EDGES) === 1 && binOf(29.9, D_EDGES) === 4 && binOf(30, D_EDGES) === 5 && binOf(500, D_EDGES) === 7, '日數級不符')
        assert.ok(binOf(-2, M_EDGES_STD) === 1 && binOf(-2.01, M_EDGES_STD) === 0 && binOf(0.19, M_EDGES_STD) === 4 && binOf(2, M_EDGES_STD) === 8, '標準化之價性級不符')

        //百分比: 指數價2000、履約價1800之賣權(ln(0.9)= −0.105 ⇒ 第1級)、距到期10日(第3級)、主動賣
        let t = mk('ETH-9JUN23-1800-P', 'sell', 5, 0.01, 60)
        assert.ok(cellKeyOf(t) === 'PS|1|3' && cellKeyOf(t, { moneyness: 'pct' }) === 'PS|1|3', `格之鍵不符 ${cellKeyOf(t)}`)
        assert.ok(cellKeyOf(mk('ETH-9JUN23-2300-C', 'buy', 5, 0.01, 60)) === 'CB|7|3', '買權之鍵不符')

        //到期當刻(08:00:00.000)入格(日數級0)、其後1毫秒即不入格
        assert.ok(cellKeyOf({ ...t, ts: Date.UTC(2023, 5, 9, 8) }) === 'PS|1|0' && cellKeyOf({ ...t, ts: Date.UTC(2023, 5, 9, 8) + 1 }) === null, '到期當刻之處置不符')

        //已過到期、主動方不明、口數非正、指數價非正、名稱不合、非物件 ⇒ null
        assert.ok(cellKeyOf({ ...t, ts: Date.UTC(2023, 5, 10) }) === null && cellKeyOf({ ...t, dir: null }) === null && cellKeyOf({ ...t, amount: 0 }) === null && cellKeyOf({ ...t, index: null }) === null && cellKeyOf({ ...t, name: 'ETH-PERPETUAL' }) === null && cellKeyOf(null) === null, '無從歸格者應為null')

        //標準化: ln(0.9)÷(iv × √(10 ÷ 365)); iv 60% ⇒ −1.06(第1級)、30% ⇒ −2.12(第0級)、120% ⇒ −0.53(第2級): 同一百分比於高波動時較接近價平
        let std = (iv) => Math.log(0.9) / ((iv / 100) * Math.sqrt(10 / 365))
        assert.ok(Math.abs(std(60) + 1.0609) < 1e-3 && Math.abs(std(30) + 2.1218) < 1e-3 && Math.abs(std(120) + 0.5305) < 1e-3, `手算值不符 ${std(60)}`)
        assert.ok(cellKeyOf(t, { moneyness: 'std' }) === 'PS|1|3' && cellKeyOf({ ...t, iv: 30 }, { moneyness: 'std' }) === 'PS|0|3' && cellKeyOf({ ...t, iv: 120 }, { moneyness: 'std' }) === 'PS|2|3', '標準化之價性級不符')

        //標準化須有正之隱含波動率; 百分比不需要
        assert.ok(cellKeyOf({ ...t, iv: null }, { moneyness: 'std' }) === null && cellKeyOf({ ...t, iv: 0 }, { moneyness: 'std' }) === null && cellKeyOf({ ...t, iv: null }) === 'PS|1|3', '無隱含波動率之處置不符')

        //到期前1分鐘、履約價高於指數價0.1%、iv 50%: 日數以下限1/24計 ⇒ 0.19(第4級); 下限改為1分鐘 ⇒ 1.45(第7級); 下限可給數字字串
        let nearExp = { ...t, name: 'ETH-9JUN23-2002-C', dir: 'buy', iv: 50, ts: Date.UTC(2023, 5, 9, 8) - 60000 }
        assert.ok(cellKeyOf(nearExp, { moneyness: 'std' }) === 'CB|4|0' && cellKeyOf(nearExp, { moneyness: 'std', minDte: 1 / 1440 }) === 'CB|7|0', `距到期日數之下限不符 ${cellKeyOf(nearExp, { moneyness: 'std' })} ${cellKeyOf(nearExp, { moneyness: 'std', minDte: 1 / 1440 })}`)
        assert.ok(cellKeyOf(nearExp, { moneyness: 'std', minDte: String(1 / 1440) }) === 'CB|7|0', '下限之數字字串應轉為數值')
    })

    it('A4 口徑選項: 給了而無效即拋(不改用預設), 訊息不帶輸入值; undefined與null為未給', function() {
        let t = mk('ETH-9JUN23-1800-P', 'sell', 5, 0.01, 60)
        let secret = 'sec-ret-value'

        //moneyness、priceInCoin、minDte決定格之歸屬與權利金之意義: 給了而無效即拋
        assert.throws(() => cellKeyOf(t, { moneyness: 'delta' }), (e) => e.message === 'invalid opt.moneyness: must be one of pct, std')
        assert.throws(() => cellKeyOf(t, { moneyness: secret }), (e) => !e.message.includes(secret) && /invalid opt\.moneyness/.test(e.message))
        assert.throws(() => cellKeyOf(t, { moneyness: 'std', minDte: 0 }), (e) => e.message === 'invalid opt.minDte: must be a positive number')
        assert.throws(() => cellKeyOf(t, { moneyness: 'std', minDte: 'abc' }), /invalid opt\.minDte/)
        assert.throws(() => aggregateTrades([], { priceInCoin: 'yes' }), (e) => e.message === 'invalid opt.priceInCoin: must be a boolean')
        assert.throws(() => aggregateTrades([], { priceInCoin: 1 }), /invalid opt\.priceInCoin/)
        assert.throws(() => aggregateTrades([], { moneyness: 'delta' }), /invalid opt\.moneyness/)

        //undefined、null視為未給(用預設); opt本身為null亦可
        assert.ok(cellKeyOf(t, { moneyness: null, minDte: undefined }) === 'PS|1|3' && cellKeyOf(t, null) === 'PS|1|3', 'null與undefined應視為未給')
        assert.ok(aggregateTrades([t], { priceInCoin: null }).n === 1 && aggregateTrades([t], null).n === 1, 'priceInCoin之null應視為未給')

        //必須參數: 非陣列即拋
        assert.throws(() => aggregateTrades(null), (e) => e.message === 'invalid trades: must be an array')
        assert.throws(() => aggregateTrades({ length: 1 }), /invalid trades/)

        //opt為已撤銷之Proxy: 讀取拋錯視為未給, 不拋
        let pr = Proxy.revocable({}, {})
        pr.revoke()
        assert.ok(aggregateTrades([t], pr.proxy).n === 1, '不可讀之opt應視為未給')
    })

    it('A5 aggregateTrades: 各格之口數、權利金、隱含波動率之加權與筆數', function() {
        let g = aggregateTrades([
            mk('ETH-9JUN23-1800-P', 'sell', 5, 0.01, 55),
            mk('ETH-9JUN23-1800-P', 'sell', 3, 0.012, 57),
            mk('ETH-9JUN23-1800-P', 'buy', 2, 0.011, null),
            mk('ETH-9JUN23-2300-C', 'buy', 7, 0.02, 60),
            mk('ETH-PERPETUAL', 'buy', 1, 1, 1),
            null,
        ])

        //同格累加: 口數8、權利金(0.01 × 5 + 0.012 × 3)× 2000、Σ iv × 口數 = 55 × 5 + 57 × 3、筆數2; 無從歸格者(含非物件)計入skipped
        assert.ok(g.n === 4 && g.skipped === 2 && Object.keys(g.cells).length === 3, `筆數或格數不符 ${JSON.stringify(g)}`)
        let c = g.cells['PS|1|3']
        assert.ok(near(c[0], 8) && near(c[1], (0.05 + 0.036) * 2000) && near(c[2], 55 * 5 + 57 * 3) && near(c[3], 8) && c[4] === 2, `賣權主動賣之格不符 ${c}`)

        //無隱含波動率者不入加權(口數與權利金仍計)
        let b = g.cells['PB|1|3']
        assert.ok(near(b[0], 2) && near(b[1], 0.011 * 2 * 2000) && b[2] === 0 && b[3] === 0 && b[4] === 1, `無隱含波動率之格不符 ${b}`)

        //權利金之報價非以標的幣計者: 價 × 口數(不乘指數價)
        let lin = aggregateTrades([mk('ETH-9JUN23-1800-P', 'sell', 5, 12.5, 55)], { priceInCoin: false })
        assert.ok(near(lin.cells['PS|1|3'][1], 62.5), `線性報價之權利金不符 ${lin.cells['PS|1|3'][1]}`)

        //價為0或負: 權利金以0計(口數與筆數仍計)
        let z = aggregateTrades([mk('ETH-9JUN23-1800-P', 'sell', 5, 0, 55)])
        assert.ok(z.cells['PS|1|3'][1] === 0 && z.cells['PS|1|3'][0] === 5, '價為0之權利金不符')
        let z2 = aggregateTrades([mk('ETH-9JUN23-1800-P', 'sell', 5, -3, 55), mk('ETH-9JUN23-1800-P', 'sell', 2, 0.5, 55)])
        assert.ok(near(z2.cells['PS|1|3'][1], 0.5 * 2000 * 2) && z2.cells['PS|1|3'][0] === 7, `價為負之權利金不符 ${z2.cells['PS|1|3']}`)

        //標準化之價性: 無隱含波動率者不入格
        let s = aggregateTrades([mk('ETH-9JUN23-1800-P', 'sell', 5, 0.01, 55), mk('ETH-9JUN23-1800-P', 'buy', 2, 0.011, null)], { moneyness: 'std' })
        assert.ok(s.n === 1 && s.skipped === 1, '標準化時無隱含波動率者應略過')
    })

    it('A6 cellSum、summarizeCells: 買賣權比、主動買賣差、偏斜、價平、期限與各類占比之手算值', function() {

        //鍵 = 類別 + 方向 | 價性級 | 日數級; 值 = [口數, 權利金, Σ iv × 口數, 有iv之口數, 筆數]
        let cells = {
            'CB|7|3': [40, 400, 40 * 60, 40, 4],
            'CS|6|4': [10, 150, 10 * 58, 10, 2],
            'PB|1|3': [20, 300, 20 * 70, 20, 3],
            'PS|2|5': [30, 600, 30 * 66, 30, 5],
            'CB|4|4': [16, 800, 16 * 50, 16, 2],
            'PS|3|1': [4, 40, 4 * 80, 4, 1],
            'CS|5|6': [8, 900, 8 * 48, 8, 1],
            'PB|0|0': [12, 6, 0, 0, 2],
        }
        assert.ok(cellSum(cells, (t) => t === 'C')[0] === 74 && cellSum(cells, (t, d) => t === 'P' && d === 'B')[1] === 306, '格之加總不符')
        let b = summarizeCells(cells)

        //口數: 買權74、賣權66、合計140; 權利金: 賣權946、合計3196
        assert.ok(b.total === 140 && near(b.pcr, 66 / 140) && near(b.pcrPrem, 946 / 3196), `買賣權比不符 ${b.pcr} ${b.pcrPrem}`)

        //主動買賣差: 買權(40 + 16)−(10 + 8)= 38; 賣權(20 + 12)−(30 + 4)= −2; 偏多 =(38 −(−2))÷ 140; 權利金版(150 + 334)÷ 3196
        assert.ok(near(b.netCall, 38 / 74) && near(b.netPut, -2 / 66) && near(b.bullFlow, 40 / 140) && near(b.bullFlowPrem, 484 / 3196), `主動買賣差不符 ${b.netCall} ${b.netPut} ${b.bullFlow} ${b.bullFlowPrem}`)

        //偏斜: 價外賣權(第1、2級; 日數級3 ~ 5)67.6 − 價外買權(第6、7級)59.6; 價平50; 期限80 − 48
        assert.ok(near(b.skew, 8) && near(b.atmIv, 50) && near(b.term, 32), `偏斜、價平或期限不符 ${b.skew} ${b.atmIv} ${b.term}`)
        assert.ok(near(b.shortShare, 16 / 140) && near(b.otmCallShare, 50 / 140) && near(b.otmPutShare, 62 / 140), `占比不符 ${b.shortShare} ${b.otmCallShare} ${b.otmPutShare}`)

        //分母為0 ⇒ NaN
        let e = summarizeCells({ 'CB|4|4': [5, 10, 0, 0, 1] })
        assert.ok(Number.isNaN(e.netPut) && Number.isNaN(e.skew) && Number.isNaN(e.atmIv) && near(e.pcr, 0), '分母為0之處置不符')
        //分母為0而分子非0(格不一致): 仍為NaN, 不為Infinity
        let e1 = summarizeCells({ 'CB|4|4': [5, 10, 60, 0, 1] })
        assert.ok(Number.isNaN(e1.atmIv), '分母為0者應為NaN')
        let e0 = summarizeCells({})
        assert.ok(e0.total === 0 && Number.isNaN(e0.pcr) && Number.isNaN(e0.bullFlow), '空之格應為0與NaN')

        //格之格式不符: 拋錯, 訊息不帶內容
        assert.throws(() => summarizeCells(null), (e2) => e2.message === 'invalid cells: must be an object of cells')
        assert.throws(() => summarizeCells([]), /invalid cells/)
        assert.throws(() => summarizeCells({ 'XX|1|1': [1, 2, 3, 4, 5] }), /invalid cells/)
        assert.throws(() => summarizeCells({ 'CB|4|4': [5, 10, 'x', 0, 1] }), /invalid cells/)
        assert.throws(() => summarizeCells({ 'CB|4|4': [5, 10] }), /invalid cells/)
    })
})
