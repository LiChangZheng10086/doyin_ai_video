import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class LocalStorage {
  constructor(private readonly baseDir: string) {}

  async ensureBaseDirs() {
    await Promise.all([
      mkdir(this.baseDir, { recursive: true }),
      mkdir(this.resolve("raw/videos"), { recursive: true }),
      mkdir(this.resolve("raw/audio"), { recursive: true }),
      mkdir(this.resolve("raw/text"), { recursive: true }),
      mkdir(this.resolve("raw/transcripts"), { recursive: true }),
      mkdir(this.resolve("raw/page"), { recursive: true }),
      mkdir(this.resolve("processed/scripts"), { recursive: true }),
      mkdir(this.resolve("processed/cleaned"), { recursive: true }),
      mkdir(this.resolve("processed/scenes"), { recursive: true }),
      mkdir(this.resolve("processed/subtitles"), { recursive: true }),
      mkdir(this.resolve("output/videos"), { recursive: true }),
      mkdir(this.resolve("output/covers"), { recursive: true }),
      mkdir(this.resolve("logs"), { recursive: true }),
      mkdir(this.resolve("cache"), { recursive: true })
    ]);
  }

  resolve(...segments: string[]) {
    return path.join(this.baseDir, ...segments);
  }

  async writeJson(relativePath: string, data: unknown) {
    const fullPath = this.resolve(relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, JSON.stringify(data, null, 2), "utf8");
    return fullPath;
  }

  async readJson<T>(relativePath: string) {
    const fullPath = this.resolve(relativePath);
    const content = await readFile(fullPath, "utf8");
    return JSON.parse(content) as T;
  }
}
