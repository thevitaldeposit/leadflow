// ── Contract / Terms templates (per business type) ──────────────────────────────
// The default contract text a customer reads and signs on the public invoice page,
// keyed by business type. Today this is the single source of the dumpster-rental
// agreement; every other type falls back to a short, business-agnostic block.
//
// All business-specific values (company name, dollar amounts, day counts, ton
// limits, fees) are intentionally left as blank `_____` fill-ins for now. A later
// "build your contract" Settings feature will let each business fill these in /
// replace the whole document per business — when it lands, store the per-business
// contract and check it BEFORE these type defaults in
// invoiceService.getEffectiveContractText (the single resolution seam). Adding a
// new vertical's contract is just another entry in CONTRACTS below.

// Business-agnostic fallback. Kept byte-for-byte as the historical invoice default
// so existing/non-dumpster invoices and the "did the owner customize it?" check in
// invoiceService are unchanged. invoiceService re-exports this as DEFAULT_TERMS.
const GENERIC_TERMS =
  'Payment is due by the due date shown above. By signing below you confirm the ' +
  'services and amounts listed are correct, authorize the work described, and ' +
  'agree to pay the total due. Returned payments or balances past due may incur ' +
  'additional fees.';

// Full dumpster-rental rental agreement. Blanks (`_____`) are filled per business
// later; nothing here is auto-filled from the invoice yet.
const DUMPSTER_RENTAL_CONTRACT = `DUMPSTER RENTAL AGREEMENT

This Dumpster Rental Agreement ("Agreement") is made between _____ ("Company") and the customer identified on this invoice ("Customer"). By signing below, Customer agrees to the following terms and conditions.

1. PAYMENT
Customer agrees to pay $_____ (rental fee) for the _____-yard container, which includes up to _____ ton(s) of materials, plus any overage charges resulting from overloading or additional rental days. Customer is responsible for landfill fees on certain items (including, but not limited to, tires, appliances, and other restricted materials). Base fees and any known additional rental time are due upon delivery. A returned-check fee will apply to any payment returned for insufficient funds. Overages are billed at $_____ per ton over the included weight allowance.

2. TERM
Each rental includes up to _____ days of rental time. Customer must contact the Company to arrange pickup or a swap of the container. To extend the rental beyond the listed pickup date, Customer must call the Company at least _____ day(s) prior to the scheduled pickup. Each additional day is $_____, if available, at the Company's sole discretion.

3. DUMPSTER PLACEMENT
The container must be placed on a flat, level surface. A minimum of _____ full-day(s) notification is required to schedule delivery, pickup, or swap service. Customer is solely responsible for obtaining any local, city, or municipal permits required for placement of the container.

4. LOADING LEVELS & WEIGHT INSTRUCTIONS
Customer is responsible for loading the container. All loads must be even and level, with no materials extending above the sides of the container. Overweight or overloaded loads are subject to a return-trip fee of $_____ plus $_____ per additional day. The container has a maximum load rating of _____ ton(s); any container loaded beyond that rating must be unloaded on site before it can be hauled.

5. NO LIQUID WASTE
Liquids of any kind are strictly prohibited in the container. Paint will only be accepted if completely dry. Disposal of wet paint is subject to a fee of $_____ per gallon.

6. SURCHARGE ITEMS
Certain items — including mattresses, box springs, large foam pads, and similar items — incur an additional charge of $_____ per item due to added landfill and transfer-station costs.

7. WASTE MATERIALS
Customer warrants that no batteries, paint, toxic, hazardous, or radioactive materials, oils, or explosives will be placed in the container. Customer agrees to indemnify, defend, and hold harmless the Company against any and all claims, costs, fees, damages, suits, penalties, and liabilities arising out of or related to Customer's breach of this warranty. These warranties survive the termination of this Agreement.

8. UNACCEPTABLE MATERIALS
The following materials are prohibited and must not be placed in the container: tires, televisions, appliances, aerosol cans, liquids of any kind, animals, antifreeze, asbestos, barrels or drums, batteries, chemicals, contaminated soil, fluorescent tubes, food waste, freon-containing items, herbicides and pesticides, industrial waste, hydraulic and lubricating oils, medical waste, motor oil, oil filters, flammable liquids, wet paint, propane tanks, radioactive materials, railroad ties, large quantities of rock/sand/dirt, and solvents. A disposal fee of $_____ per item will be charged for any restricted item found in the container.

9. CUSTOMER'S RESPONSIBILITY FOR RENTED DUMPSTER
While the container is in Customer's possession and control, Customer holds harmless and indemnifies the Company against any claim or liability for injury or property damage arising from the use or presence of the container. Customer is responsible for the cleanliness and safekeeping of the container and is liable for any damage resulting from fire, theft, vandalism, negligence, graffiti, natural disasters, or similar causes. Customer is responsible for any applicable taxes. Customer shall not overload the container or use it for incineration.

10. PROPERTY DAMAGE
Customer warrants that any right-of-way, driveway, or surface provided for placement of the container will bear the weight of the Company's equipment and vehicles. An optional Driveway Protection Add-on is available for $_____. The Company is not responsible for damage to driveways, roads, approaches, sidewalks, or yards resulting from delivery, placement, or pickup of the container.

Thank you for your business!`;

// Registry of default contracts by normalized business-type key. Add a vertical's
// default here (e.g. hvac, plumbing) when its contract is written; until then a
// type falls through to GENERIC_TERMS.
const CONTRACTS = {
  dumpster_rental: DUMPSTER_RENTAL_CONTRACT,
  generic: GENERIC_TERMS,
};

// Normalize a free-text business type into a stable key. Accepts the title-case
// signup values (businesses.industry_type, e.g. "Dumpster Rental"), the lead-style
// vertical/sub_vertical slugs (e.g. "dumpster_rental"), and loose variants.
// Returns null only for empty input so callers can distinguish "no type set" (use
// an env/anchor fallback) from "type set but no dedicated contract" (use generic).
function businessTypeKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('dumpster')) return 'dumpster_rental';
  if (s.includes('hvac')) return 'hvac';
  if (s.includes('plumb')) return 'plumbing';
  if (s.includes('landscap')) return 'landscaping';
  if (s.includes('roof')) return 'roofing';
  return 'other';
}

// The default contract text for a normalized type key. Unknown/keyless → generic.
function resolveDefaultContract(typeKey) {
  return CONTRACTS[typeKey] || GENERIC_TERMS;
}

module.exports = {
  GENERIC_TERMS,
  DUMPSTER_RENTAL_CONTRACT,
  businessTypeKey,
  resolveDefaultContract,
};
