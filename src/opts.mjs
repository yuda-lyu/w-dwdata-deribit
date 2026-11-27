import iseint from 'wsemi/src/iseint.mjs'
import isenum from 'wsemi/src/isenum.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'


//本檔為輸入參數之檢測輔助(內部使用): opt之逐鍵讀取一律經wsemi之getOptReader(給了而無效改用預設，opt.debug為true時警告)，
//必須參數(位置參數)與決定資料口徑、下載來源、網路出口之選項給了而無效即拋(fail-closed)，訊息為'invalid <名稱>: must be <種類>'，不帶輸入值


//toNum, 已通過iseint或isenum檢測之值轉為數值(數字字串去頭尾空白後轉換，其後一律使用轉換值；-0以0計)
let toNum = (v) => {
    let n = typeof v === 'string' ? Number(v.trim()) : v
    return n === 0 ? 0 : n
}


//fail, 拋錯, 訊息只帶名稱與種類
let fail = (name, desc) => {
    throw new Error(`invalid ${name}: must be ${desc}`)
}


//isStr, 非空之原始字串且不含NUL
let isStr = (v) => {
    return typeof v === 'string' && v !== '' && !v.includes('\0')
}


//needStr, 必須參數: 非空字串
let needStr = (name, v) => {
    if (!isStr(v)) {
        fail(name, 'a non-empty string')
    }
    return v
}


//needTs, 必須參數: 毫秒時間戳(數字或數字字串)
let needTs = (name, v) => {
    if (!iseint(v, { use: 'timestamp' })) {
        fail(name, 'a timestamp in milliseconds')
    }
    return toNum(v)
}


//needRange, 必須參數: 起訖時刻, 迄須大於起
let needRange = (nameStart, vStart, nameEnd, vEnd) => {
    let a = needTs(nameStart, vStart)
    let b = needTs(nameEnd, vEnd)
    if (!(b > a)) {
        fail(nameEnd, `greater than ${nameStart}`)
    }
    return [a, b]
}


//readInt, opt之整數類選項: 未給或給了而無效取預設(opt.debug為true時警告), 有效者轉為數值
let readInt = (rd, key, def, spec, desc, defDesc) => {
    let v = rd(key, def, (x) => iseint(x, spec), desc, defDesc)
    return toNum(v)
}


//readStrict, opt之決定口徑類選項: 未給(undefined、null)取預設, 給了而無效即拋(不改用預設)
let readStrict = (rd, key, def, check, desc) => {
    let v = rd.read(key)
    if (v === undefined || v === null) {
        return def
    }
    let ok = false
    try {
        ok = check(v) === true
    }
    catch (err) {
        //check拋錯視為無效
    }
    if (!ok) {
        fail(`opt.${key}`, desc)
    }
    return v
}


//parseHost, 主機網址(http或https, 不帶帳密、查詢與片段); 有效者回去除尾端斜線之網址, 否則回null
let parseHost = (v) => {
    if (!isStr(v)) {
        return null
    }
    let u = null
    try {
        u = new URL(v)
    }
    catch (err) {
        return null
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
        return null
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}


//readHost, opt之主機網址: 決定下載來源, 給了而無效即拋
let readHost = (rd, key, def) => {
    let v = rd.read(key)
    if (v === undefined || v === null) {
        return def
    }
    let h = parseHost(v)
    if (h === null) {
        fail(`opt.${key}`, 'an http(s) url without credentials, query or hash')
    }
    return h
}


//readProxy, opt.proxy: 決定網路出口, 給了而無效即拋(改用預設會使請求不經代理直連); 回新物件(不改寫呼叫端之物件), 未給回undefined
let readProxy = (rd) => {
    let v = rd.read('proxy')
    if (v === undefined || v === null) {
        return undefined
    }
    let desc = 'an object { protocol, host, port, auth }'

    //各欄只讀一次(讀取拋錯視為無效)
    let host, protocol, port, auth, user, pw
    try {
        if (!iseobj(v)) {
            fail('opt.proxy', desc)
        }
        host = v.host
        protocol = v.protocol
        port = v.port
        auth = v.auth
        if (auth !== undefined && auth !== null) {
            if (!iseobj(auth)) {
                fail('opt.proxy', desc)
            }
            user = auth.username
            pw = auth.password
        }
    }
    catch (err) {
        fail('opt.proxy', desc)
    }
    if (!isStr(host) || /[\s/?#@]/.test(host) || !iseint(port, { use: 'port' })) {
        fail('opt.proxy', desc)
    }
    let r = { host, port: toNum(port) }
    if (protocol !== undefined && protocol !== null) {
        if (typeof protocol !== 'string' || !/^https?:?$/.test(protocol)) {
            fail('opt.proxy', desc)
        }
        r.protocol = protocol.replace(/:$/, '')
    }
    if (auth !== undefined && auth !== null) {
        if (typeof user !== 'string' || typeof pw !== 'string') {
            fail('opt.proxy', desc)
        }
        r.auth = { username: user, password: pw }
    }
    return r
}


//isPosNum, 正之有效數字(數字或數字字串)
let isPosNum = (v) => isenum(v, { gt: 0 })


export { toNum, fail, isStr, needStr, needTs, needRange, readInt, readStrict, parseHost, readHost, readProxy, isPosNum }
