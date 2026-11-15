import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** S-03: manifest shape. If dist/ has been built, every file it references must exist there. */
const ext = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));

function referencedFiles(m: typeof manifest): string[] {
  return [
    m.background.service_worker,
    m.action.default_popup,
    ...m.content_scripts.flatMap((c: { js: string[] }) => c.js),
    ...Object.values(m.icons as Record<string, string>),
    ...Object.values(m.action.default_icon as Record<string, string>),
  ];
}

describe("manifest.json", () => {
  it("is MV3 with the smallest permission set (activeTab dropped: host permissions cover tab.url)", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(["scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.content_scripts[0]).toMatchObject({ matches: ["http://*/*", "https://*/*"], run_at: "document_idle", js: ["content.js"] });
    expect(manifest.action.default_popup).toBe("popup.html");
  });

  it.runIf(existsSync(join(ext, "dist", "manifest.json")))("dist contains every referenced file", () => {
    for (const f of [...referencedFiles(manifest), "popup.js", "popup.css"]) expect(existsSync(join(ext, "dist", f)), f).toBe(true);
    const png = readFileSync(join(ext, "dist", "icons", "icon128.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(128);
  });
});
