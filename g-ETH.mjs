//範例(手動執行, 會連線至Deribit之公開端點): 下載ETH選擇權之逐筆成交至每日檔, 再以使用端之日界取用
import WDwdataDeribit from './src/WDwdataDeribit.mjs'


async function test() {

    //wdd
    let wdd = WDwdataDeribit()

    //下載ETH選擇權之逐筆成交至每日檔(UTC日, 已有檔之日不重抓)
    let r = await wdd.saveTrades('ETH', 'option', './data/ETH/option', '2024-02-29', { dayEnd: '2024-03-01' })
    console.log(r.saved.map((v) => [v.day, v.n]))

    //以使用端之日界取用(此例為台北2024-03-01 = [02-29T16:00Z, 03-01T16:00Z)): 讀檔 → 格 → 每日基本量
    let tStart = Date.parse('2024-02-29T16:00:00Z')
    let s = wdd.summarizeRange('./data/ETH/option', tStart, tStart + 86400000)
    console.log(s.complete, s.n, s.summary.pcr)

}
test()
