import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import { isWithinOneEdit } from "../../src/lib/stocksage/text-normalization";

test("bounded typo matching covers edits and rejects wider changes", () => {
  assert.equal(isWithinOneEdit("macquaire", "macquarie"), true);
  assert.equal(isWithinOneEdit("later", "latter"), true);
  assert.equal(isWithinOneEdit("forget", "orget"), true);
  assert.equal(isWithinOneEdit("macquari", "macquarie"), true);
  assert.equal(isWithinOneEdit("market", "macquarie"), false);
  assert.equal(isWithinOneEdit("later", "former"), false);
});
