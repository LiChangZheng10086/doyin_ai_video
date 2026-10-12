// Run: node --import tsx scripts/verify-sau-bgm.mjs [Python executable]. Uses SAU_BINARY or PATH sau otherwise.
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
try {
  await mkdir(path.join(root, 'uploader/douyin_uploader'), { recursive: true });
  await writeFile(path.join(root, 'uploader/__init__.py'), '');
  await writeFile(path.join(root, 'uploader/douyin_uploader/__init__.py'), '');
  await writeFile(path.join(root, 'uploader/douyin_uploader/main.py'), 'class DouYinNote:\n    pass\n');
  const entry = path.join(root, 'fake-sau.py');
  await writeFile(entry, String.raw`
import asyncio, json, os
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
    ]
    if os.environ.get("VERIFY_CASE"):
        cases = [case for case in cases if case["id"] == os.environ["VERIFY_CASE"]]
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ["VERIFY_BROWSER"], headless=True)
        try:
            for case in cases:
                context = await browser.new_context()
                await context.route("**/*", lambda route: route.abort())
                page = await context.new_page()
                html = """<button>选择音乐</button><button onclick="document.querySelector('.semi-sidesheet-content').style.display='block'">选择音乐</button>
                    <div class="semi-sidesheet-content" style="display:none"><input class="semi-input" placeholder="搜索音乐"><div id="cards"></div></div>
                    <script>
                    const config = CONFIG;
                    window.selected = null;
                    function card(title, version) {
                        const node = document.createElement('div'); node.className = config.changedHash ? 'card-container-X' : 'card-container-tmocjc';
                        const name = document.createElement('span'); name.className = config.missingTitle ? 'unknown-title' : config.changedHash ? 'song-name-Y' : 'song-name-oRge4d'; name.textContent = title; node.append(name);
                        const button = document.createElement('button'); button.className = config.changedHash ? 'apply-btn-Z' : 'apply-btn-LUPP0D'; button.textContent = '使用';
                        button.onclick = () => { document.body.dataset.selected = version; if(config.apply) document.querySelector('.semi-sidesheet-content').style.display='none'; };
                        node.append(button); return node;
                    }
                    const cards = document.querySelector('#cards'); cards.append(card(config.old, 'old'));
                    document.querySelector('input').addEventListener('keydown', event => {
                        if(event.key !== 'Enter') return;
                        setTimeout(() => { cards.replaceChildren(); if(config.prefix) cards.append(card('不相关音乐', 'unrelated')); cards.append(card(config.new, 'new')); }, 300);
                    });
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
                    selected=await page.locator("body").get_attribute("data-selected"), error=error))
                await context.close()
        finally:
            await browser.close()
    print("RESULT=" + json.dumps(results, ensure_ascii=False), flush=True)

asyncio.run(check())
`);
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
  const { stdout } = await promisify(execFile)(python, ['-c', STRICT_NOTE_BGM_SCRIPT, entry], {
    cwd: root, env: { ...process.env, VERIFY_BROWSER: target.path, VERIFY_CASE: '' }, timeout: 90000, maxBuffer: 1024 * 1024,
  });
  const results = JSON.parse(stdout.split('\n').find(line => line.startsWith('RESULT=')).slice(7));
  for (const result of results) console.log(JSON.stringify(result));
  const failed = results.filter(result => result.published !== result.expected || result.expected && result.selected !== (result.id === 'stale_same_title' ? 'old' : 'new'));
  assert.deepEqual(failed, [], '选曲必须等待本轮搜索结果、匹配完整标题，且失败不能进入发布');
  assert.match(results.find(result => result.id === 'remix_rejected').error, /Whatever Happens Remix/, '失败提示应展示实际候选名称');
  assert.match(results.find(result => result.id === 'other_title_rejected').error, /What Happens/, '失败提示应展示实际候选名称');
  for (const id of ['remix_rejected', 'other_title_rejected']) {
    assert.match(results.find(result => result.id === id).error, /抖音音乐库未找到匹配配乐/);
    assert.doesNotMatch(results.find(result => result.id === id).error, /Timeout|Locator\.wait_for/, '无匹配结果应输出可读提示');
  }
  const missingTitleError = results.find(result => result.id === 'missing_title_selector').error;
  assert.match(missingTitleError, /Whatever Happens.*Michael Jackson.*页面布局已变化/, '标题定位失效时应展示音乐侧栏文本');
  assert.doesNotMatch(missingTitleError, /无可用搜索结果|Timeout|Locator\.wait_for/);
  assert.equal(results.length, 11);
  console.log(`PASS: ${results.length} Python bootstrap and real Chromium music cases (no platform publishing)`);
} finally { await rm(root, { recursive: true, force: true }); }
