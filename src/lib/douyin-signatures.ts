/**
 * 抖音签名算法 (纯 TypeScript 实现)
 *
 * 基于 Evil0ctal/Douyin_TikTok_Download_API 和 DLWangSan/douyin_parse 项目。
 * - A-Bogus: SM3 哈希 + RC4 加密 + 自定义 Base64 编码
 * - X-Bogus: MD5 哈希 + RC4 加密 + 自定义 Base64 编码
 *
 * 依赖 Node.js 22+ 内置的 crypto.createHash('sm3')
 */

import crypto from "node:crypto";

// ─── 字符映射表 ──────────────────────────────────────────────────

const CHARSETS = {
  s0: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  s1: "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
  s2: "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
  s3: "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
  s4: "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
} as const;

// ─── SM3 哈希辅助 ─────────────────────────────────────────────────

function sm3Hash(data: string | Buffer): string {
  return crypto.createHash("sm3").update(data).digest("hex");
}

function sm3HashToArray(data: string): number[] {
  const hex = sm3Hash(data);
  const arr: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    arr.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return arr;
}

// ─── RC4 加密 ─────────────────────────────────────────────────────

function rc4Encrypt(plaintext: string, key: string): string {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }

  let i = 0;
  j = 0;
  const result: string[] = [];
  for (const ch of plaintext) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    const t = (s[i] + s[j]) % 256;
    result.push(String.fromCharCode(s[t] ^ ch.charCodeAt(0)));
  }
  return result.join("");
}

function rc4EncryptBytes(key: Buffer, data: Buffer): Buffer {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }

  let i = 0;
  j = 0;
  const encrypted = Buffer.alloc(data.length);
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) % 256;
    j = (j + S[i]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
    encrypted[k] = data[k] ^ S[(S[i] + S[j]) % 256];
  }
  return encrypted;
}

// ─── MD5 哈希辅助 ─────────────────────────────────────────────────

function md5Hash(data: string | Buffer | number[]): string {
  const buf = Array.isArray(data) ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
  return crypto.createHash("md5").update(buf).digest("hex");
}

function md5StrToArray(md5Str: string): number[] {
  // Pre-build lookup map for hex chars
  const charMap: Record<number, number> = {};
  for (let i = 0; i < 10; i++) charMap[48 + i] = i;     // '0'-'9'
  for (let i = 0; i < 6; i++) charMap[97 + i] = 10 + i; // 'a'-'f'

  if (md5Str.length > 32) {
    return Array.from(md5Str).map(c => c.charCodeAt(0));
  }

  const arr: number[] = [];
  for (let i = 0; i < md5Str.length; i += 2) {
    const high = charMap[md5Str.charCodeAt(i)];
    const low = charMap[md5Str.charCodeAt(i + 1)];
    arr.push((high << 4) | low);
  }
  return arr;
}

// ─── Base64 编码 (自定义字符集) ────────────────────────────────────

function customBase64Encode(s: string, charset: keyof typeof CHARSETS = "s4"): string {
  const cs = CHARSETS[charset];
  const result: string[] = [];

  for (let i = 0; i < s.length; i += 3) {
    const remaining = s.length - i;
    if (remaining >= 3) {
      const n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i + 2);
      result.push(
        cs[(n >> 18) & 63],
        cs[(n >> 12) & 63],
        cs[(n >> 6) & 63],
        cs[n & 63]
      );
    } else if (remaining === 2) {
      const n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8);
      result.push(
        cs[(n >> 18) & 63],
        cs[(n >> 12) & 63],
        cs[(n >> 6) & 63]
      );
    } else {
      const n = s.charCodeAt(i) << 16;
      result.push(
        cs[(n >> 18) & 63],
        cs[(n >> 12) & 63]
      );
    }
  }

  // 补等号
  const padding = (4 - (result.length % 4)) % 4;
  for (let p = 0; p < padding; p++) {
    result.push("=");
  }
  return result.join("");
}

// ─── 随机辅助 ─────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateBrowserInfo(platform?: string): string {
  const innerW = randInt(1280, 1920);
  const innerH = randInt(720, 1080);
  const outerW = randInt(innerW, 1920);
  const outerH = randInt(innerH, 1080);
  const values = [
    innerW, innerH, outerW, outerH,
    0, Math.random() < 0.5 ? 0 : 30, 0, 0,
    outerW, outerH, outerW, outerH,
    innerW, innerH, 24, 24,
    platform || "MacIntel",
  ];
  return values.join("|");
}

// ═══════════════════════════════════════════════════════════════════
// A-Bogus 签名生成器
// ═══════════════════════════════════════════════════════════════════

interface ABogusOptions {
  userAgent?: string;
  platform?: string;
}

export class ABogus {
  private readonly _regInit = [
    1937774191, 1226093241, 388252375, 3666478592,
    2842636476, 372324522, 3817729613, 2969243214,
  ];

  private readonly _uaCode = [
    76, 98, 15, 131, 97, 245, 224, 133, 122, 199,
    241, 166, 79, 34, 90, 191, 128, 126, 122, 98,
    66, 11, 14, 40, 49, 110, 110, 173, 67, 96, 138, 252,
  ];

  private readonly _endString = "cus";
  private readonly _browser: string;
  private readonly _browserLen: number;
  private readonly _browserCode: number[];

  constructor(options: ABogusOptions = {}) {
    this._browser = generateBrowserInfo(options.platform);
    this._browserLen = this._browser.length;
    this._browserCode = Array.from(this._browser).map(c => c.charCodeAt(0));
  }

  // ── 内部方法 ─────────────────────────────────────────────────

  private _list1(randomNum?: number): number[] {
    return this._randomList(randomNum, 170, 85, 1, 2, 5, 45 & 170);
  }

  private _list2(randomNum?: number): number[] {
    return this._randomList(randomNum, 170, 85, 1, 0, 0, 0);
  }

  private _list3(randomNum?: number): number[] {
    return this._randomList(randomNum, 170, 85, 1, 0, 5, 0);
  }

  private _randomList(
    a?: number, b = 170, c = 85, d = 0, e = 0, f = 0, g = 0
  ): number[] {
    const r = a ?? (Math.random() * 10000);
    const v = [r, (r | 0) & 255, (r | 0) >> 8];
    return [
      v[1] & b | d,
      v[1] & c | e,
      v[2] & b | f,
      v[2] & c | g,
    ];
  }

  // 生成三个随机字符的拼接
  private _generateString1(r1?: number, r2?: number, r3?: number): string {
    const l1 = this._list1(r1);
    const l2 = this._list2(r2);
    const l3 = this._list3(r3);
    return String.fromCharCode(l1[0], l1[1], l1[2], l1[3]) +
           String.fromCharCode(l2[0], l2[1], l2[2], l2[3]) +
           String.fromCharCode(l3[0], l3[1], l3[2], l3[3]);
  }

  // 生成主签名串 (string_2)
  private _generateString2(
    urlParams: string, method = "GET",
    startTime = 0, endTime = 0
  ): string {
    const a = this._list4Arr(urlParams, method, startTime, endTime);
    const e = this._endCheckNum(a);
    a.push(...this._browserCode);
    a.push(e);
    return rc4Encrypt(String.fromCharCode(...a), "y");
  }

  private _list4Arr(
    urlParams: string, method = "GET",
    startTime = 0, endTime = 0
  ): number[] {
    const now = Date.now();
    startTime = startTime || now;
    endTime = endTime || (now + randInt(4, 8));

    const paramsArr = this._generateParamsCode(urlParams);
    const methodArr = this._generateMethodCode(method);

    return [
      44,
      (endTime >> 24) & 255, 0, 0, 0, 0, 24,
      paramsArr[21], methodArr[21], 0,
      this._uaCode[23], (endTime >> 16) & 255, paramsArr[22],
      this._uaCode[24], (endTime >> 8) & 255, (endTime >> 0) & 255,
      0, 0, 0, 0,
      (startTime >> 24) & 255, (startTime >> 16) & 255,
      0, 0, 14,
      (startTime >> 8) & 255, (startTime >> 0) & 255,
      0,
      methodArr[22],
      (endTime / 256 / 256 / 256 / 256) & 0xFF,
      (startTime / 256 / 256 / 256 / 256) & 0xFF,
      3,
      this._browserLen,
      1, 1, 0, 0, 0,
    ];
  }

  // SM3("GET" + "cus") → hex → array → SM3 → array
  private _generateMethodCode(method: string): number[] {
    return sm3HashToArray(sm3Hash(method + this._endString));
  }

  // SM3(params + "cus") → hex → array → SM3 → array
  private _generateParamsCode(params: string): number[] {
    return sm3HashToArray(sm3Hash(params + this._endString));
  }

  // 校验位：所有字节的异或
  private _endCheckNum(arr: number[]): number {
    let r = 0;
    for (const v of arr) r ^= v;
    return r;
  }

  // ── 主接口 ─────────────────────────────────────────────────

  /**
   * 生成 A-Bogus 签名
   *
   * @param urlParams - URL 参数字符串 (如 "device_platform=webapp&aid=6383...")
   *                    或对象 (自动转为 URL 编码字符串)
   * @param method - HTTP 方法 ("GET" | "POST")
   * @param startTime - 起始时间戳 (毫秒)，默认当前时间
   * @param endTime - 结束时间戳 (毫秒)，默认 startTime + 4~8ms
   * @returns A-Bogus 签名字符串 (使用时需 URL 编码)
   */
  getValue(
    urlParams: string | Record<string, string | number>,
    method: "GET" | "POST" = "GET",
    startTime = 0,
    endTime = 0,
  ): string {
    const paramsStr = typeof urlParams === "string"
      ? urlParams
      : new URLSearchParams(
          Object.fromEntries(
            Object.entries(urlParams).map(([k, v]) => [k, String(v)])
          )
        ).toString();

    const string1 = this._generateString1();
    const string2 = this._generateString2(paramsStr, method, startTime, endTime);
    return customBase64Encode(string1 + string2, "s4");
  }
}

// ═══════════════════════════════════════════════════════════════════
// X-Bogus 签名生成器
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";

const UA_KEY_XB = Buffer.from([0x00, 0x01, 0x0c]);

export class XBogus {
  private readonly userAgent: string;

  constructor(userAgent?: string) {
    this.userAgent = userAgent || DEFAULT_USER_AGENT;
  }

  /**
   * 生成 X-Bogus 签名
   *
   * @param urlPath - URL 参数字符串 (不含问号，如 "device_platform=webapp&aid=6383...")
   *                  或完整 URL (自动去掉路径部分，只取 query string)
   * @returns { result: 带 X-Bogus 的完整参数字符串, xbogus: X-Bogus 值, userAgent: 使用的 UA }
   */
  getXBogus(urlPath: string): { result: string; xbogus: string; userAgent: string } {
    // 如果传入了完整 URL，提取 query string
    const idx = urlPath.indexOf("?");
    if (idx >= 0) {
      urlPath = urlPath.slice(idx + 1);
    }

    // 1. RC4 加密 User-Agent
    const rc4Encrypted = rc4EncryptBytes(
      UA_KEY_XB,
      Buffer.from(this.userAgent, "latin1")
    );

    // 2. MD5(base64(rc4(u)))
    const array1 = md5StrToArray(
      md5Hash(Buffer.from(rc4Encrypted.toString("base64"), "latin1"))
    );

    // 3. MD5(MD5("d41d8cd98f00b204e9800998ecf8427e"))
    const array2 = md5StrToArray(
      md5Hash(md5StrToArray("d41d8cd98f00b204e9800998ecf8427e"))
    );

    // 4. MD5(MD5(url_path))
    const urlPathArray = md5StrToArray(md5Hash(md5StrToArray(md5Hash(urlPath))));

    // 5. 时间戳和常量
    const timer = Math.floor(Date.now() / 1000);
    const ct = 536919696;

    // 6. 构建新数组
    const newArray: (number | string)[] = [
      64,
      0.00390625,
      1, 12,
      urlPathArray[14], urlPathArray[15],
      array2[14], array2[15],
      array1[14], array1[15],
      (timer >> 24) & 255, (timer >> 16) & 255,
      (timer >> 8) & 255, timer & 255,
      (ct >> 24) & 255, (ct >> 16) & 255,
      (ct >> 8) & 255, ct & 255,
    ];

    // 7. 异或校验
    let xorResult = 0;
    for (const val of newArray) {
      xorResult ^= typeof val === "number" ? val : Number(val);
    }
    newArray.push(xorResult);

    // 8. 拆分奇偶位并合并
    const array3: number[] = [];
    const array4: number[] = [];
    for (let i = 0; i < newArray.length; i++) {
      const val = typeof newArray[i] === "number" ? newArray[i] as number : Number(newArray[i]);
      if (i % 2 === 0) array3.push(val);
      else array4.push(val);
    }
    const mergeArray = [...array3, ...array4];

    // 9. 构建 ISO-8859-1 字符串 (关键：字节值 0-255 直接映射到 Latin-1 字符)
    // 按照原算法顺序: a, int(i), b, _, c, x, e, u, d, s, t, l, f, v, r, h, n, p, o
    const [a, i, b, _, c, x, e, u, d, s, t, l, f, v, r, h, n, p, o] = mergeArray;
    const encodingStr = String.fromCharCode(
      a, Math.floor(i || 0), b, _, c, x, e, u,
      d, s, t, l, f, v, r, h, n, p, o
    );

    // 10. RC4 加密
    const garbled = String.fromCharCode(2, 255) +
      rc4EncryptBytes(
        Buffer.from([0xff]),
        Buffer.from(encodingStr, "latin1")
      ).toString("latin1");

    // 11. 最终 X-Bogus 编码
    let xb = "";
    const charset = CHARSETS.s2;
    for (let i = 0; i < garbled.length; i += 3) {
      const n1 = garbled.charCodeAt(i);
      const n2 = garbled.charCodeAt(i + 1);
      const n3 = garbled.charCodeAt(i + 2);
      const x = ((n1 & 255) << 16) | ((n2 & 255) << 8) | n3;
      xb += charset[(x >> 18) & 63] +
            charset[(x >> 12) & 63] +
            charset[(x >> 6) & 63] +
            charset[x & 63];
    }

    return {
      result: `${urlPath}&X-Bogus=${xb}`,
      xbogus: xb,
      userAgent: this.userAgent,
    };
  }
}

// ─── 便捷工具 ─────────────────────────────────────────────────────

/**
 * 为抖音 API 请求构建带签名的完整 URL
 *
 * @param baseUrl - API 地址 (带路径，不含问号)
 * @param params - 请求参数对象
 * @param userAgent - 浏览器 UA (用于 X-Bogus 签名)
 * @returns 带有 a_bogus 和 X-Bogus 签名的完整 URL
 */
export function signDouyinRequest(
  baseUrl: string,
  params: Record<string, string | number>,
  userAgent?: string,
): { url: string; userAgent: string } {
  const paramStr = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();

  // A-Bogus (新签名)
  const ab = new ABogus();
  const aBogus = ab.getValue(params);

  // X-Bogus (也加上作为兼容)
  const xb = new XBogus(userAgent);
  const xbResult = xb.getXBogus(paramStr);

  // a_bogus 需要 URL 编码特殊字符
  const encodedABogus = encodeURIComponent(aBogus);

  const url = `${baseUrl}?${xbResult.result}&a_bogus=${encodedABogus}`;
  return { url, userAgent: xbResult.userAgent };
}

/**
 * 为抖音用户主页 API 生成签名请求
 */
export function signUserPostRequest(
  secUserId: string,
  maxCursor = 0,
  count = 18,
  userAgent?: string,
): { url: string; userAgent: string } {
  const params: Record<string, string | number> = {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    pc_client_type: "1",
    version_code: "170400",
    version_name: "17.4.0",
    cookie_enabled: "true",
    browser_language: "zh-CN",
    browser_platform: "MacIntel",
    browser_name: "Chrome",
    browser_online: "true",
    engine_name: "Blink",
    os_name: "Mac OS",
    os_version: "10",
    platform: "PC",
    screen_width: "1920",
    screen_height: "1080",
    cpu_core_num: "12",
    sec_user_id: secUserId,
    max_cursor: String(maxCursor),
    count: String(count),
    locate_query: "false",
    show_live_replay_strategy: "1",
    need_time_list: "1",
    time_list_query: "0",
    whale_cut_token: "",
    cut_version: "1",
    publish_video_strategy_type: "2",
  };

  return signDouyinRequest(
    "https://www.douyin.com/aweme/v1/web/aweme/post/",
    params,
    userAgent,
  );
}

/**
 * 为抖音视频详情 API 生成签名请求
 */
export function signAwemeDetailRequest(
  awemeId: string,
  userAgent?: string,
): { url: string; userAgent: string } {
  const params: Record<string, string | number> = {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    pc_client_type: "1",
    version_code: "170400",
    version_name: "17.4.0",
    cookie_enabled: "true",
    browser_language: "zh-CN",
    browser_platform: "MacIntel",
    browser_name: "Chrome",
    browser_online: "true",
    engine_name: "Blink",
    os_name: "Mac OS",
    os_version: "10",
    platform: "PC",
    screen_width: "1920",
    screen_height: "1080",
    aweme_id: awemeId,
  };

  return signDouyinRequest(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/",
    params,
    userAgent,
  );
}
