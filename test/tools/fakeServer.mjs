//本機假伺服器(測試輔助): 只聽127.0.0.1之系統配發埠, 不連外
import http from 'http'


/**
 * 啟動假伺服器
 *
 * @param {Function} handler - (req, res, u)=>{}，u為以請求網址解析之URL物件；回傳（或resolve）後不自動結束回應，由handler自行res.end
 * @returns {Promise} resolve回傳 { host('http://127.0.0.1:埠'), port, requests(各請求之 { method, url, headers }), sockets(目前連線數), close() }
 */
let startServer = async (handler) => {
    let requests = []
    let socks = new Set()
    let srv = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url, headers: req.headers })
        let u = new URL(req.url, 'http://127.0.0.1')
        Promise.resolve(handler(req, res, u)).catch(() => {
            res.destroy()
        })
    })
    srv.on('connection', (s) => {
        socks.add(s)
        s.on('close', () => socks.delete(s))
    })
    await new Promise((resolve) => {
        srv.listen(0, '127.0.0.1', resolve)
    })
    let port = srv.address().port
    return {
        host: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: async () => {
            for (let s of socks) {
                s.destroy()
            }
            await new Promise((resolve) => {
                srv.close(resolve)
            })
        },
    }
}


//sendJson, 回JSON
let sendJson = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(obj))
}


//withNoProxy, 使axios不因環境變數(HTTP_PROXY等)而改走代理: 設定NO_PROXY, 回還原函數
let withNoProxy = () => {
    let keys = ['NO_PROXY', 'no_proxy']
    let old = keys.map((k) => process.env[k])
    for (let k of keys) {
        process.env[k] = '127.0.0.1,localhost'
    }
    return () => {
        keys.forEach((k, i) => {
            if (old[i] === undefined) {
                delete process.env[k]
            }
            else {
                process.env[k] = old[i]
            }
        })
    }
}


export { startServer, sendJson, withNoProxy }
