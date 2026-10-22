import { expect, test } from "bun:test";
import { packageUrl } from "../src/links";
import type { Package } from "../src/types";

const pkg = (manager: string, name: string, extra?: Package["extra"]): Package => ({
  manager,
  name,
  installed: "1.0",
  status: "up-to-date",
  extra,
});

test("registry pages per manager", () => {
  expect(packageUrl(pkg("brew", "ripgrep"))).toBe("https://formulae.brew.sh/formula/ripgrep");
  expect(packageUrl(pkg("npm", "@types/node"))).toBe("https://www.npmjs.com/package/@types/node");
  expect(packageUrl(pkg("bun", "typescript"))).toBe("https://www.npmjs.com/package/typescript");
  expect(packageUrl(pkg("pip", "rich"))).toBe("https://pypi.org/project/rich/");
  expect(packageUrl(pkg("cargo", "bat"))).toBe("https://crates.io/crates/bat");
  expect(packageUrl(pkg("gem", "rake"))).toBe("https://rubygems.org/gems/rake");
  expect(packageUrl(pkg("dnf", "7zip"))).toBe(
    "https://packages.fedoraproject.org/search?query=7zip",
  );
  expect(packageUrl(pkg("flatpak", "org.gimp.GIMP"))).toBe(
    "https://flathub.org/apps/org.gimp.GIMP",
  );
});

test("go and gh-ext need adapter metadata", () => {
  expect(packageUrl(pkg("go", "gopls"))).toBeNull();
  expect(packageUrl(pkg("go", "gopls", { modulePath: "golang.org/x/tools/gopls" }))).toBe(
    "https://pkg.go.dev/golang.org/x/tools/gopls",
  );
  expect(packageUrl(pkg("gh-ext", "gh-dash", { repo: "dlvhdr/gh-dash" }))).toBe(
    "https://github.com/dlvhdr/gh-dash",
  );
});

test("names are encoded and unknown managers have no page", () => {
  expect(packageUrl(pkg("brew", "a b"))).toBe("https://formulae.brew.sh/formula/a%20b");
  expect(packageUrl(pkg("npm", "weird name"))).toBe("https://www.npmjs.com/package/weird%20name");
  expect(packageUrl(pkg("plugin-mgr", "x"))).toBeNull();
});
