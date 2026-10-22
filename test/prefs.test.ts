import { expect, test } from "bun:test";
import { parsePrefs } from "../src/prefs";

test("keeps valid fields", () => {
  expect(
    parsePrefs(
      JSON.stringify({
        sortKey: "name",
        sortDir: "desc",
        groupByManager: true,
        showDetail: false,
        view: "outdated",
        theme: "gruvbox",
        icons: false,
      }),
    ),
  ).toEqual({
    sortKey: "name",
    sortDir: "desc",
    groupByManager: true,
    showDetail: false,
    view: "outdated",
    theme: "gruvbox",
    icons: false,
  });
});

test("drops invalid fields instead of failing", () => {
  expect(parsePrefs(JSON.stringify({ sortKey: "size", sortDir: "up", icons: "yes" }))).toEqual({});
});

test("tolerates garbage", () => {
  expect(parsePrefs("not json")).toEqual({});
  expect(parsePrefs("[1,2]")).toEqual({});
  expect(parsePrefs("null")).toEqual({});
});
