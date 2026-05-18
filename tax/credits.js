/**
 * Federal Tax Credits Module (2025)
 * Simplified, conservative credit calculations for estimation purposes only.
 *
 * SCOPE: Only CTC and ODC (nonrefundable portions)
 * NOT IMPLEMENTED: EITC, ACTC refundable mechanics, education credits, ACA credits
 *
 * @module tax/credits
 */

/**
 * @typedef {'single' | 'mfj' | 'hoh' | 'mfs'} FilingStatus
 */

/**
 * @typedef {Object} DependentsInputs
 * @property {number} dependents - Total number of dependents (integer >= 0)
 * @property {number} childrenUnder17 - Number of qualifying children under 17 (<= dependents)
 */

/**
 * @typedef {Object} CreditsInputs
 * @property {FilingStatus} filingStatus - Filing status
 * @property {number} agi - Adjusted Gross Income (for phaseout calculation)
 * @property {number} federalTaxBeforeCredits - Federal tax liability before credits
 * @property {DependentsInputs} dependents - Dependents information
 * @property {boolean} [applyPhaseout=false] - Whether to apply simplified CTC/ODC phaseout
 */

/**
 * @typedef {Object} CreditsResult
 * @property {number} childTaxCreditFull - Full CTC before phaseout ($2,000 per child)
 * @property {number} otherDependentCreditFull - Full ODC before phaseout ($500 per other dependent)
 * @property {number} totalCreditsFull - Total credits before phaseout
 * @property {number} phaseoutAmount - Amount reduced due to phaseout
 * @property {number} totalCreditsAfterPhaseout - Credits after phaseout applied
 * @property {number} nonrefundableCreditsApplied - Credits actually applied (limited to tax liability)
 * @property {number} federalTaxAfterCredits - Federal tax after credits applied
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Child Tax Credit amount per qualifying child under 17 (2025)
 */
const CTC_AMOUNT_2025 = 2000;

/**
 * Other Dependent Credit amount per non-child dependent (2025)
 */
const ODC_AMOUNT_2025 = 500;

/**
 * CTC/ODC phaseout thresholds by filing status (2025 estimates)
 * Credits reduce by $50 for each $1,000 (or part thereof) above threshold
 */
const CTC_PHASEOUT_THRESHOLDS = {
  single: 200000,
  mfj: 400000,
  hoh: 200000,
  mfs: 200000
};

/**
 * Phaseout rate: $50 reduction per $1,000 above threshold
 */
const PHASEOUT_RATE_PER_1000 = 50;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Round to cents (2 decimal places)
 * @param {number} value
 * @returns {number}
 */
function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

// =============================================================================
// Credit Calculation Functions
// =============================================================================

/**
 * Calculate the CTC/ODC phaseout amount based on AGI
 *
 * The credit phases out by $50 for each $1,000 (or fraction) of AGI above the threshold.
 *
 * @param {number} agi - Adjusted Gross Income
 * @param {FilingStatus} filingStatus - Filing status
 * @param {number} totalCredits - Total credits before phaseout
 * @returns {number} Phaseout reduction amount
 */
function calculatePhaseout(agi, filingStatus, totalCredits) {
  const threshold = CTC_PHASEOUT_THRESHOLDS[filingStatus] || 200000;

  if (agi <= threshold) {
    return 0;
  }

  // Calculate excess AGI above threshold
  const excessAgi = agi - threshold;

  // Reduce by $50 per $1,000 (or part thereof) above threshold
  const thousandsAbove = Math.ceil(excessAgi / 1000);
  const phaseout = thousandsAbove * PHASEOUT_RATE_PER_1000;

  // Phaseout cannot exceed total credits
  return Math.min(phaseout, totalCredits);
}

/**
 * Calculate federal tax credits for dependents (2025)
 *
 * This implements a simplified, conservative model:
 * - Child Tax Credit: $2,000 per qualifying child under 17
 * - Other Dependent Credit: $500 per dependent not counted as under-17 child
 * - Credits are nonrefundable (cannot reduce tax below zero)
 * - Optional simplified phaseout for high-income filers
 *
 * IMPORTANT: This is for estimation only. Actual eligibility and amounts vary.
 *
 * @param {CreditsInputs} inputs - Credits calculation inputs
 * @returns {CreditsResult} Calculated credits result
 */
function calcFederalCredits(inputs) {
  const {
    filingStatus,
    agi,
    federalTaxBeforeCredits,
    dependents,
    applyPhaseout = false
  } = inputs;

  // Extract dependents with validation
  const totalDependents = Math.max(0, Math.floor(dependents.dependents || 0));
  const childrenUnder17 = Math.max(0, Math.min(
    Math.floor(dependents.childrenUnder17 || 0),
    totalDependents
  ));
  const otherDependents = totalDependents - childrenUnder17;

  // Calculate full credit amounts
  const childTaxCreditFull = childrenUnder17 * CTC_AMOUNT_2025;
  const otherDependentCreditFull = otherDependents * ODC_AMOUNT_2025;
  const totalCreditsFull = childTaxCreditFull + otherDependentCreditFull;

  // Apply phaseout if enabled
  let phaseoutAmount = 0;
  if (applyPhaseout && totalCreditsFull > 0) {
    phaseoutAmount = calculatePhaseout(agi, filingStatus, totalCreditsFull);
  }

  const totalCreditsAfterPhaseout = Math.max(0, totalCreditsFull - phaseoutAmount);

  // Apply as nonrefundable credit (cannot exceed tax liability)
  const nonrefundableCreditsApplied = Math.min(
    totalCreditsAfterPhaseout,
    Math.max(0, federalTaxBeforeCredits)
  );

  // Calculate tax after credits
  const federalTaxAfterCredits = roundToCents(
    Math.max(0, federalTaxBeforeCredits - nonrefundableCreditsApplied)
  );

  return {
    childTaxCreditFull: roundToCents(childTaxCreditFull),
    otherDependentCreditFull: roundToCents(otherDependentCreditFull),
    totalCreditsFull: roundToCents(totalCreditsFull),
    phaseoutAmount: roundToCents(phaseoutAmount),
    totalCreditsAfterPhaseout: roundToCents(totalCreditsAfterPhaseout),
    nonrefundableCreditsApplied: roundToCents(nonrefundableCreditsApplied),
    federalTaxAfterCredits
  };
}

/**
 * Get the phaseout threshold for a filing status
 *
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {number} AGI threshold where phaseout begins
 */
function getPhaseoutThreshold(filingStatus) {
  return CTC_PHASEOUT_THRESHOLDS[filingStatus] || 200000;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  calcFederalCredits,
  calculatePhaseout,
  getPhaseoutThreshold,
  roundToCents,

  // Constants
  CTC_AMOUNT_2025,
  ODC_AMOUNT_2025,
  CTC_PHASEOUT_THRESHOLDS,
  PHASEOUT_RATE_PER_1000
};
