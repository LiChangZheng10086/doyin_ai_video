// The upstream treats music errors as optional; override this step only inside the music upload process.
export const STRICT_NOTE_BGM_SCRIPT = String.raw`
import asyncio, os, re, runpy, sys
from urllib.parse import parse_qs, urlsplit
sys.path.insert(0, os.getcwd())
from uploader.douyin_uploader.main import DouYinNote

async def select_required_bgm(self, page, name):
    try:
        entry = page.locator('text="选择音乐"').nth(1)
        if not await entry.count():
            entry = page.locator('text="选择音乐"').first
        await entry.wait_for(state="visible", timeout=10000)
        await entry.click()
        sheet = page.locator(".semi-sidesheet-content").first
        await sheet.wait_for(state="visible", timeout=8000)
        search = sheet.locator('input.semi-input[placeholder="搜索音乐"]').first
        await search.wait_for(state="visible", timeout=5000)
        requests = []
        failures = []
        def is_search(request):
            url = urlsplit(request.url)
            return url.path.rstrip("/") == "/openapi/aweme/v1/music/search" and parse_qs(url.query).get("keyword", [""])[0] == name
        def requested(request):
            if is_search(request):
                requests.append(request)
        def failed(request):
            if request in requests:
                failures.append(request.failure or "网络请求失败")
        async def search_once():
            async with page.expect_response(lambda response: response.request in requests, timeout=0) as pending:
                await search.fill("")
                await search.fill(name)
                await search.press("Enter")
            response = await pending.value
            if response.status != 200:
                raise RuntimeError("抖音音乐搜索请求失败（HTTP " + str(response.status) + "），请检查网络或登录状态")
            await response.finished()
            data = await response.json()
            if not isinstance(data, dict) or data.get("status_code") != 0:
                code = data.get("status_code", "响应格式变化") if isinstance(data, dict) else "响应格式变化"
                raise RuntimeError("抖音音乐搜索返回异常（" + str(code) + "），请检查登录状态或稍后重试")
            await sheet.get_by_text("加载中", exact=True).first.wait_for(state="hidden", timeout=0)
        page.on("request", requested)
        page.on("requestfailed", failed)
        try:
            for attempt in range(2):
                requests.clear()
                failures.clear()
                print("正在等待抖音音乐搜索结果（" + str(attempt + 1) + "/2）", flush=True)
                try:
                    await asyncio.wait_for(search_once(), timeout=30)
                    break
                except Exception as error:
                    if not isinstance(error, asyncio.TimeoutError) and not failures:
                        raise
                    if attempt == 0:
                        print("音乐搜索加载未完成，仅重新搜索一次，不重试上传或发布", flush=True)
                        # Reopening resets the site's debounced query cache for the same song.
                        await page.locator(".semi-sidesheet-close").first.click(timeout=5000)
                        await sheet.wait_for(state="hidden", timeout=5000)
                        await entry.click(timeout=5000)
                        await sheet.wait_for(state="visible", timeout=8000)
                        await search.wait_for(state="visible", timeout=5000)
                        continue
                    detail = failures[-1][:100] if failures else "请求已发出但未完成加载" if requests else "未检测到本次搜索请求"
                    raise RuntimeError("抖音音乐搜索加载未完成：" + detail + "。已阻止发布，请检查网络或稍后重试，无需修改歌名") from error
        finally:
            page.remove_listener("request", requested)
            page.remove_listener("requestfailed", failed)
        normalized = "".join(name.split())
        pattern = r"^\s*" + r"\s*".join(re.escape(char) for char in normalized) + r"\s*$"
        title_match = page.locator('[class*="song-name-"]', has_text=re.compile(pattern, re.I))
        card = sheet.locator('[class*="card-container-"]').filter(has=title_match).first
        try:
            await card.wait_for(state="visible", timeout=5000)
        except Exception as error:
            titles = await sheet.locator('[class*="song-name-"]').all_text_contents()
            found = "、".join(title.strip() for title in titles[:5]) or (await sheet.inner_text()).strip()[:300] or "无可用搜索结果"
            raise RuntimeError("抖音音乐库未找到匹配配乐「" + name + "」，当前结果：" + found + "。请使用抖音音乐库完整歌曲名重新建包。") from error
        title = await card.locator('[class*="song-name-"]').first.inner_text()
        if "".join(title.split()).casefold() != normalized.casefold():
            raise RuntimeError("搜索结果名称不符：" + title)
        button = card.locator('[class*="apply-btn-"]').first
        await button.evaluate("el => el.click()")
        await sheet.wait_for(state="hidden", timeout=5000)
        print("配乐已应用：" + title, flush=True)
        return True
    except Exception as error:
        raise RuntimeError("指定配乐未能应用，已阻止发布：" + str(error)) from error

DouYinNote.select_bgm = select_required_bgm
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
