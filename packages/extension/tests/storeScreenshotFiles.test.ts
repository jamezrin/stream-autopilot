import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
// @ts-expect-error The production utility is an executable JavaScript module.
import { STORE_SCREENSHOT_LOCALES, STORE_SCREENSHOT_VARIANTS, parseRequestedLocales, screenshotFilename } from "../scripts/store-screenshot-config.mjs";
// @ts-expect-error The production utility is an executable JavaScript module.
import { validateStoreScreenshotFiles } from "../scripts/store-screenshot-files.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lurkloot-store-screenshots-"));
  temporaryDirectories.push(directory);
  return directory;
}

function png(width = 1280, height = 800): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function writeLocale(root: string, locale: string): string {
  const localeDirectory = join(root, locale);
  mkdirSync(localeDirectory, { recursive: true });
  for (const variant of STORE_SCREENSHOT_VARIANTS) {
    writeFileSync(join(localeDirectory, screenshotFilename(variant)), png());
  }
  return localeDirectory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("store screenshot manifest", () => {
  it("describes the exact upload order", () => {
    expect(STORE_SCREENSHOT_LOCALES.map(({ code }: { code: string }) => code)).toEqual([
      "en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr",
    ]);
    expect(STORE_SCREENSHOT_VARIANTS.map(screenshotFilename)).toEqual([
      "lurkloot-01-drops-1280x800.png",
      "lurkloot-02-extras-1280x800.png",
      "lurkloot-03-easy-1280x800.png",
      "lurkloot-04-settings-1280x800.png",
      "lurkloot-05-updated-1280x800.png",
    ]);
    expect(STORE_SCREENSHOT_VARIANTS.map((variant: { popup: boolean }) => variant.popup)).toEqual([
      true, true, true, true, false,
    ]);
  });

  it("parses locale filters without accepting unknown or duplicate work", () => {
    expect(parseRequestedLocales([])).toEqual([
      "en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr",
    ]);
    expect(parseRequestedLocales(["--locales", "ar", "tr"])).toEqual(["ar", "tr"]);
    expect(parseRequestedLocales(["--", "--locales", "ar", "tr", "--validate-only"])).toEqual(["ar", "tr"]);
    expect(parseRequestedLocales(["--validate-only"])).toEqual([
      "en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr",
    ]);
    expect(() => parseRequestedLocales(["--locales", "ar", "ar"])).toThrow(/duplicate locale ar/i);
    expect(() => parseRequestedLocales(["--locales", "xx"])).toThrow(/unknown locale xx/i);
    expect(() => parseRequestedLocales(["--locales"])).toThrow(/requires at least one locale/i);
    expect(() => parseRequestedLocales(["--locale", "en"])).toThrow(/unknown option --locale/i);
  });
});

describe("store screenshot file validation", () => {
  it("returns real valid PNG files in upload order", async () => {
    const root = temporaryDirectory();
    writeLocale(root, "en");

    const files = await validateStoreScreenshotFiles({ root, locales: ["en"] });

    expect(files.get("en")?.map(({ path }: { path: string }) => basename(path))).toEqual([
      "lurkloot-01-drops-1280x800.png",
      "lurkloot-02-extras-1280x800.png",
      "lurkloot-03-easy-1280x800.png",
      "lurkloot-04-settings-1280x800.png",
      "lurkloot-05-updated-1280x800.png",
    ]);
  });

  it("rejects a missing expected image", async () => {
    const root = temporaryDirectory();
    const localeDirectory = writeLocale(root, "en");
    rmSync(join(localeDirectory, "lurkloot-03-easy-1280x800.png"));

    await expect(validateStoreScreenshotFiles({ root, locales: ["en"] })).rejects.toThrow(/missing.*03-easy/i);
  });

  it("rejects unexpected PNGs instead of uploading stale assets", async () => {
    const root = temporaryDirectory();
    const localeDirectory = writeLocale(root, "en");
    writeFileSync(join(localeDirectory, "lurkloot-01-twitch-drops-1280x800.png"), png());

    await expect(validateStoreScreenshotFiles({ root, locales: ["en"] })).rejects.toThrow(/unexpected.*01-twitch-drops/i);
  });

  it("rejects non-PNG and incorrectly sized files", async () => {
    const invalidRoot = temporaryDirectory();
    const invalidDirectory = writeLocale(invalidRoot, "en");
    writeFileSync(join(invalidDirectory, "lurkloot-02-extras-1280x800.png"), Buffer.from("not a png"));
    await expect(validateStoreScreenshotFiles({ root: invalidRoot, locales: ["en"] })).rejects.toThrow(/not a PNG/i);

    const wrongSizeRoot = temporaryDirectory();
    const wrongSizeDirectory = writeLocale(wrongSizeRoot, "en");
    writeFileSync(join(wrongSizeDirectory, "lurkloot-04-settings-1280x800.png"), png(640, 400));
    await expect(validateStoreScreenshotFiles({ root: wrongSizeRoot, locales: ["en"] })).rejects.toThrow(/640x400.*1280x800/i);
  });
});
