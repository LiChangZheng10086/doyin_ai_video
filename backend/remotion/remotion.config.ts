import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer("swiftshader");
Config.setDelayRenderTimeoutInMilliseconds(120000);

// Use system Chrome if specified via env var, otherwise Remotion auto-downloads
const chromePath = process.env.REMOTION_CHROME_PATH;
if (chromePath) {
  Config.setBrowserExecutable(chromePath);
}
