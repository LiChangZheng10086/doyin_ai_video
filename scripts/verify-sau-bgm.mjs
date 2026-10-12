// Run: node --import tsx scripts/verify-sau-bgm.mjs [Python executable]. Uses SAU_BINARY or PATH sau otherwise.
// VERIFY_CASE=<case id> runs one case without the historical reproduction group.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { STRICT_NOTE_BGM_SCRIPT } from '../src/lib/sau-bgm.ts';
import { resolveToutiaoBrowser } from '../dist/lib/toutiao-browser.js';

let python = process.argv[2];
if (!python) {
  const candidates = process.env.SAU_BINARY ? [process.env.SAU_BINARY] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'sau'));
  for (const binary of candidates) {
    try {
      const shebang = (await readFile(binary, 'utf8')).split('\n')[0];
      if (shebang?.startsWith('#!')) python = shebang.slice(2).trim();
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
assert(python && path.isAbsolute(python) && /^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(python)),
  '请通过首参数指定安装patchright的Python绝对路径，或配置Python shebang入口SAU_BINARY（也可将sau加入PATH）');
await access(python);

const target = resolveToutiaoBrowser({ repoRoot: process.cwd(), env: {}, allowSystemChrome: false }).target;
assert(target?.kind === 'executablePath', '项目隔离浏览器不可用');
const root = await mkdtemp(path.join(os.tmpdir(), 'verify-sau-bgm-'));
const caseId = process.env.VERIFY_CASE ?? '';
try {
  await mkdir(path.join(root, 'uploader/douyin_uploader'), { recursive: true });
  await writeFile(path.join(root, 'uploader/__init__.py'), '');
  await writeFile(path.join(root, 'uploader/douyin_uploader/__init__.py'), '');
  await writeFile(path.join(root, 'uploader/douyin_uploader/main.py'), 'class DouYinNote:\n    pass\n');
  const entry = path.join(root, 'fake-sau.py');
  await writeFile(entry, String.raw`
import asyncio, json, os
from urllib.parse import parse_qs, urlparse
from patchright.async_api import async_playwright
from uploader.douyin_uploader.main import DouYinNote

async def check():
    cases = [
        dict(id="delayed_results", old="旧音乐", new="目标音乐", apply=True, expected=True),
        dict(id="stale_same_title", old="目标音乐", new="目标音乐", apply=True, expected=True),
        dict(id="exact_second_card", old="旧音乐", new="目标音乐", apply=True, expected=True, prefix=True),
        dict(id="wrong_title", old="旧音乐", new="目标音乐Remix", apply=True, expected=False),
        dict(id="apply_failure", old="旧音乐", new="目标音乐", apply=False, expected=False),
        dict(id="missing_spaces", old="旧音乐", new="Whatever Happens", name="whateverhappens", apply=True, expected=True),
        dict(id="mixed_case_and_spaces", old="旧音乐", new="Whatever   Happens", name="  WhATever \tHAPPENS  ", apply=True, expected=True),
        dict(id="remix_rejected", old="旧音乐", new="Whatever Happens Remix", name="whateverhappens", apply=True, expected=False),
        dict(id="other_title_rejected", old="旧音乐", new="What Happens", name="whateverhappens", apply=True, expected=False),
        dict(id="changed_css_hash", old="旧音乐", new="Whatever Happens", name="Whatever Happens", apply=True, expected=True, changedHash=True),
        dict(id="missing_title_selector", old="旧音乐", new="Whatever Happens · Michael Jackson · 页面布局已变化", name="Whatever Happens", apply=True, expected=False, missingTitle=True),
        dict(id="loading_over_8s", old="旧音乐", new="Whatever Happens", name="Whatever Happens", apply=True, expected=True, loading=True, delay=9500),
        dict(id="loading_forever", old="旧音乐", new="Whatever Happens", name="Whatever Happens", apply=True, expected=False, loading=True, forever=True),
        dict(id="stale_same_title_loading", old="Whatever Happens", new="Whatever Happens", name="Whatever Happens", apply=True, expected=True, loading=True, delay=900),
        dict(id="http_403", old="旧音乐", new="Whatever Happens", name="Whatever Happens", apply=True, expected=False, httpStatus=403),
        dict(id="network_retry_success", old="旧音乐", new="Whatever Happens", name="Whatever Happens", apply=True, expected=True, abortFirst=True),
    ]
    if os.environ.get("VERIFY_CASE"):
        cases = [case for case in cases if case["id"] == os.environ["VERIFY_CASE"]]
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ["VERIFY_BROWSER"], headless=True)
        try:
            for case in cases:
                context = await browser.new_context()
                keywords = []
                async def music_response(route):
                    url = urlparse(route.request.url)
                    if url.hostname != "tsearch.amemv.com" or url.path != "/openapi/aweme/v1/music/search/":
                        await route.abort()
                        return
                    keyword = parse_qs(url.query).get("keyword", [""])[0]
                    keywords.append(keyword)
                    expected_keyword = case.get("name", "目标音乐")
                    assert "".join(keyword.split()).casefold() == "".join(expected_keyword.split()).casefold(), "模拟搜索关键词必须来自当前输入"
                    if case.get("abortFirst") and len(keywords) == 1:
                        await route.abort("connectionreset")
                        return
                    try:
                        await asyncio.sleep(60 if case.get("forever") else case.get("delay", 300) / 1000)
                        await route.fulfill(status=case.get("httpStatus", 200), headers={"Access-Control-Allow-Origin": "*"}, content_type="application/json",
                            body=json.dumps(dict(status_code=0, music=[dict(music_name=case["new"])])))
                    except Exception:
                        if not page.is_closed():
                            raise
                await context.route("**/*", music_response)
                page = await context.new_page()
                html = """<button>选择音乐</button><button onclick="openMusic()">选择音乐</button>
                    <div class="semi-sidesheet-content" style="display:none"><button class="semi-sidesheet-close" onclick="closeMusic()">关闭</button><input class="semi-input" placeholder="搜索音乐"><div id="cards"></div></div>
                    <script>
                    const config = CONFIG;
                    window.selected = null;
                    function card(title, version) {
                        const node = document.createElement('div'); node.className = config.changedHash ? 'card-container-X' : 'card-container-tmocjc';
                        const name = document.createElement('span'); name.className = config.missingTitle ? 'unknown-title' : config.changedHash ? 'song-name-Y' : 'song-name-oRge4d'; name.textContent = title; node.append(name);
                        const button = document.createElement('button'); button.className = config.changedHash ? 'apply-btn-Z' : 'apply-btn-LUPP0D'; button.textContent = '使用';
                        button.onclick = () => { document.body.dataset.clicks = String(Number(document.body.dataset.clicks ?? 0) + 1); document.body.dataset.selected = version; if(document.querySelector('#loading')?.style.display === 'block') document.body.dataset.premature = 'true'; if(config.apply) document.querySelector('.semi-sidesheet-content').style.display='none'; };
                        node.append(button); return node;
                    }
                    const cards = document.querySelector('#cards'); cards.append(card(config.old, 'old'));
                    const loading = document.createElement('span'); loading.id = 'loading'; loading.textContent = '加载中'; loading.style.display = 'none'; cards.parentNode.append(loading);
                    const input = document.querySelector('input'); const inputs = []; let debounce, lastKeyword;
                    function openMusic() {
                        clearTimeout(debounce); lastKeyword = null; input.value = ''; loading.style.display = 'none'; cards.replaceChildren(card(config.old, 'old'));
                        document.querySelector('.semi-sidesheet-content').style.display = 'block'; document.body.dataset.opens = String(Number(document.body.dataset.opens ?? 0) + 1);
                    }
                    function closeMusic() {
                        clearTimeout(debounce); document.querySelector('.semi-sidesheet-content').style.display = 'none'; document.body.dataset.closes = String(Number(document.body.dataset.closes ?? 0) + 1);
                    }
                    function search() {
                        clearTimeout(debounce);
                        if(!input.value || input.value === lastKeyword) return;
                        lastKeyword = input.value;
                        loading.style.display = 'block';
                        fetch('https://tsearch.amemv.com/openapi/aweme/v1/music/search/?keyword=' + encodeURIComponent(input.value))
                            .then(response => { if(!response.ok) throw new Error('HTTP ' + response.status); return response.json(); }).then(() => { cards.replaceChildren(); if(config.prefix) cards.append(card('不相关音乐', 'unrelated')); cards.append(card(config.new, 'new')); loading.style.display = 'none'; }).catch(() => {});
                    }
                    input.addEventListener('keydown', event => { if(event.key === 'Enter') search(); });
                    input.addEventListener('input', () => { inputs.push(input.value); document.body.dataset.inputs = JSON.stringify(inputs); clearTimeout(debounce); debounce = setTimeout(search, 500); });
                    </script>""".replace("CONFIG", json.dumps(case, ensure_ascii=False))
                await page.set_content(html)
                published = False
                error = None
                try:
                    selected = await DouYinNote().select_bgm(page, case.get("name", "目标音乐"))
                    if selected:
                        published = True  # Simulates continuation into upload; no real uploader is invoked.
                except Exception as caught:
                    error = str(caught)
                results.append(dict(id=case["id"], expected=case["expected"], published=published,
                    selected=await page.locator("body").get_attribute("data-selected"), premature=await page.locator("body").get_attribute("data-premature"), error=error,
                    keywords=keywords[:], clicks=int(await page.locator("body").get_attribute("data-clicks") or 0), inputs=json.loads(await page.locator("body").get_attribute("data-inputs") or "[]"),
                    opens=int(await page.locator("body").get_attribute("data-opens") or 0), closes=int(await page.locator("body").get_attribute("data-closes") or 0)))
                await context.close()
        finally:
            await browser.close()
    print("RESULT=" + json.dumps(results, ensure_ascii=False), flush=True)

asyncio.run(check())
`);
  if (!caseId) {
  // Reproduce the previous exact-space comparison without changing the production source.
  const previous = STRICT_NOTE_BGM_SCRIPT
    .replace('normalized = "".join(name.split())', 'normalized = name.strip()')
    .replace(String.raw`pattern = r"^\s*" + r"\s*".join(re.escape(char) for char in normalized) + r"\s*$"`, String.raw`pattern = r"^\s*" + re.escape(normalized) + r"\s*$"`)
    .replace('"".join(title.split()).casefold()', 'title.strip().casefold()');
  assert.notEqual(previous, STRICT_NOTE_BGM_SCRIPT, '旧版空白匹配复现未构造成功');
  const prior = await promisify(execFile)(python, ['-c', previous, entry], {
    cwd: root, env: { ...process.env, VERIFY_BROWSER: target.path, VERIFY_CASE: 'missing_spaces' }, timeout: 20000, maxBuffer: 1024 * 1024,
  });
  const oldResult = JSON.parse(prior.stdout.split('\n').find(line => line.startsWith('RESULT=')).slice(7))[0];
  assert.equal(oldResult.published, false, '旧匹配必须复现无空格歌名找不到结果');
  console.log('PASS: previous exact-space matcher reproduces missing_spaces failure');
  const previousHash = STRICT_NOTE_BGM_SCRIPT
    .replaceAll('[class*="song-name-"]', '.song-name-oRge4d')
    .replaceAll('[class*="card-container-"]', '.card-container-tmocjc')
    .replaceAll('[class*="apply-btn-"]', '.apply-btn-LUPP0D');
  assert.notEqual(previousHash, STRICT_NOTE_BGM_SCRIPT, '旧版CSS哈希定位复现未构造成功');
  const priorHash = await promisify(execFile)(python, ['-c', previousHash, entry], {
    cwd: root, env: { ...process.env, VERIFY_BROWSER: target.path, VERIFY_CASE: 'changed_css_hash' }, timeout: 20000, maxBuffer: 1024 * 1024,
  });
  const oldHashResult = JSON.parse(priorHash.stdout.split('\n').find(line => line.startsWith('RESULT=')).slice(7))[0];
  assert.equal(oldHashResult.published, false, '旧定位必须复现CSS哈希变更找不到结果');
  console.log('PASS: previous hard-coded CSS suffixes reproduce changed_css_hash failure');
  }
  if (!caseId || caseId === 'network_retry_success') {
    // A one-second deadline preserves the old cache failure while keeping its regression check fast.
    const clearOnly = STRICT_NOTE_BGM_SCRIPT
      .replace(/\s+await page\.locator\("\.semi-sidesheet-close"\)\.first\.click\(timeout=5000\)\n\s+await sheet\.wait_for\(state="hidden", timeout=5000\)\n\s+await entry\.click\(timeout=5000\)\n\s+await sheet\.wait_for\(state="visible", timeout=8000\)\n\s+await search\.wait_for\(state="visible", timeout=5000\)/, '')
      .replace('await asyncio.wait_for(search_once(), timeout=30)', 'await asyncio.wait_for(search_once(), timeout=1)');
    assert(!clearOnly.includes('page.locator(".semi-sidesheet-close").first.click'), '旧版clear-only复现必须移除面板重开');
    const oldRetry = await promisify(execFile)(python, ['-c', clearOnly, entry], {
      cwd: root, env: { ...process.env, VERIFY_BROWSER: target.path, VERIFY_CASE: 'network_retry_success' }, timeout: 10000, maxBuffer: 1024 * 1024,
    });
    const oldRetryResult = JSON.parse(oldRetry.stdout.split('\n').find(line => line.startsWith('RESULT=')).slice(7))[0];
    assert.equal(oldRetryResult.published, false); assert.equal(oldRetryResult.keywords.length, 1);
    assert.equal(oldRetryResult.opens, 1); assert.equal(oldRetryResult.closes, 0);
    console.log('PASS: previous clear-only retry sends no second request and blocks publishing');
  }
  const { stdout } = await promisify(execFile)(python, ['-c', STRICT_NOTE_BGM_SCRIPT, entry], {
    cwd: root, env: { ...process.env, VERIFY_BROWSER: target.path, VERIFY_CASE: caseId }, timeout: 180000, maxBuffer: 1024 * 1024,
  });
  const results = JSON.parse(stdout.split('\n').find(line => line.startsWith('RESULT=')).slice(7));
  for (const result of results) console.log(JSON.stringify(result));
  const failed = results.filter(result => result.published !== result.expected || result.expected && result.selected !== 'new');
  assert.deepEqual(failed, [], '选曲必须等待本轮搜索结果、匹配完整标题，且失败不能进入发布');
  assert(results.every(result => result.premature !== 'true'), '加载期间不得点击旧卡片');
  if (results.some(result => result.id === 'remix_rejected')) assert.match(results.find(result => result.id === 'remix_rejected').error, /Whatever Happens Remix/, '失败提示应展示实际候选名称');
  if (results.some(result => result.id === 'other_title_rejected')) assert.match(results.find(result => result.id === 'other_title_rejected').error, /What Happens/, '失败提示应展示实际候选名称');
  for (const id of ['remix_rejected', 'other_title_rejected']) {
    if (!results.some(result => result.id === id)) continue;
    assert.match(results.find(result => result.id === id).error, /抖音音乐库未找到匹配配乐/);
    assert.doesNotMatch(results.find(result => result.id === id).error, /Timeout|Locator\.wait_for/, '无匹配结果应输出可读提示');
  }
  const missingTitle = results.find(result => result.id === 'missing_title_selector');
  if (missingTitle) {
    assert.match(missingTitle.error, /Whatever Happens.*Michael Jackson.*页面布局已变化/, '标题定位失效时应展示音乐侧栏文本');
    assert.doesNotMatch(missingTitle.error, /无可用搜索结果|Timeout|Locator\.wait_for/);
  }
  const forever = results.find(result => result.id === 'loading_forever');
  if (forever) {
    assert.match(forever.error, /加载|请求/, '永久加载应提示加载或请求未完成');
    assert.doesNotMatch(forever.error, /完整歌曲名|未找到匹配配乐|无可用搜索结果/, '加载未结束不能归因歌曲名称');
  }
  const forbidden = results.find(result => result.id === 'http_403');
  if (forbidden) {
    assert.match(forbidden.error, /HTTP 403/);
    assert.doesNotMatch(forbidden.error, /完整歌曲名|未找到匹配配乐/);
    assert.equal(forbidden.clicks, 0); assert.equal(forbidden.keywords.length, 1, 'HTTP拒绝不能反复重搜');
  }
  const retried = results.find(result => result.id === 'network_retry_success');
  if (retried) {
    assert.deepEqual(retried.keywords, ['Whatever Happens', 'Whatever Happens']);
    assert.equal(retried.clicks, 1, '网络重搜成功后只能应用一次');
    assert.equal(retried.opens, 2, '同名重搜必须重新打开音乐面板以重置缓存');
    assert.equal(retried.closes, 1);
    assert.equal(retried.inputs.at(-1), 'Whatever Happens');
  }
  assert.equal(results.length, caseId ? 1 : 16);
  console.log(`PASS: ${results.length} Python bootstrap and real Chromium music cases (no platform publishing)`);
} finally { await rm(root, { recursive: true, force: true }); }
