/** 真机取码回归：只取二维码并取消，不扫码、不保存 Cookie。 */
import assert from "node:assert/strict";
import { cancelDouyinQrLogin, pollDouyinQrLogin, startDouyinQrLogin } from "../src/lib/douyin-cookie.js";

try {
  const started = await startDouyinQrLogin();
  assert.match(started.qrDataUrl, /^data:image\//);
  assert.equal((await pollDouyinQrLogin()).status, "waiting");
} finally {
  await cancelDouyinQrLogin();
}
assert.equal((await pollDouyinQrLogin()).status, "idle");
console.log("抖音应用内二维码获取、轮询与取消通过");
