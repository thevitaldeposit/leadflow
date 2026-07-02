// ── Canonical size key (shared by inventory + pricing) ─────────────────────────
// Inventory stores sizes as free text ("20 yard"); the pricing list keys them as
// "20yd". They didn't share a normalized form, so a size→rate join wasn't reliable.
// This is the ONE normalizer both layers use: any size-shaped string collapses to
// the canonical "<n>yd" key:
//   "20 yard", "20-yard dumpster", "20yd", "20 YD", "20", "20 cubic yards" → "20yd"
// A non-size service key (e.g. "delivery", "cleanup", "net30") returns null — it is
// not a dumpster size and must keep its own free-form service_key untouched.
//
// Prompt B will use normalizeSizeKey() to join a lead's requested size to its price
// row. Keeping the numeric basis identical to inventoryService.normalizeSize() (the
// leading integer) means inventory sizes and price keys always agree.
function normalizeSizeKey(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  // Leading integer, optionally followed by a size unit (yd/yard(s)/cubic yard(s)/cy)
  // and/or a container noun (dumpster/container/bin/roll-off). Nothing else may follow,
  // so "net30" / "tier2" / "delivery" are correctly rejected as non-sizes.
  const m = s.match(
    /^(\d+)[\s-]*(?:yd|yard|yards|yarder|cy|cubic\s*yards?)?[\s-]*(?:dumpster|container|bin|roll[-\s]?off|rolloff)?$/
  );
  if (!m) return null;
  return `${parseInt(m[1], 10)}yd`;
}

// True when two size-ish strings refer to the same dumpster size. Both must
// normalize to the same canonical key (null never matches null here — a non-size
// key is not "the same size" as anything).
function sizeKeyMatches(a, b) {
  const ka = normalizeSizeKey(a);
  const kb = normalizeSizeKey(b);
  return ka != null && ka === kb;
}

module.exports = { normalizeSizeKey, sizeKeyMatches };
