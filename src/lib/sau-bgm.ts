// The upstream treats music errors as optional; override this step only inside the music upload process.
export const STRICT_NOTE_BGM_SCRIPT = String.raw`
import os, re, runpy, sys
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
        await search.fill(name)
        await search.press("Enter")
        normalized = "".join(name.split())
        pattern = r"^\s*" + r"\s*".join(re.escape(char) for char in normalized) + r"\s*$"
        title_match = page.locator('[class*="song-name-"]', has_text=re.compile(pattern, re.I))
        card = sheet.locator('[class*="card-container-"]').filter(has=title_match).first
        try:
            await card.wait_for(state="visible", timeout=8000)
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
