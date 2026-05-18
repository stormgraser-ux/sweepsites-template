/**
 * Oregon Tax Module
 * Oregon state tax calculation functions for 2025.
 *
 * @module tax/oregon
 */

/**
 * @typedef {'single' | 'mfj' | 'hoh' | 'mfs'} FilingStatus
 */

/**
 * @typedef {Object} OregonInputs
 * @property {2025} taxYear - Tax year (currently only 2025 supported)
 * @property {FilingStatus} filingStatus - Filing status (single implemented, others structured)
 * @property {number} agi - Adjusted Gross Income (same as federal: gross - capitalLossUsed)
 * @property {number} deduction - Deduction amount (standard or itemized, mirroring federal method)
 * @property {boolean} [exemptionCreditEligible=true] - Whether exemption credit applies (default: AGI < 100k for single)
 * @property {boolean} [applyKicker=false] - Whether to apply Oregon kicker (Advanced)
 * @property {number} [or40Line24TotalTaxBeforeCredits=0] - 2024 OR-40 line 24 for kicker calculation (Advanced)
 */

/**
 * @typedef {Object} OregonTaxResult
 * @property {number} taxableIncome - AGI minus deduction
 * @property {number} taxBeforeCredits - Tax calculated from brackets
 * @property {number} exemptionCredit - Exemption credit applied (0 if not eligible)
 * @property {number} taxAfterExemption - Tax after exemption credit
 * @property {number} kickerCredit - Kicker credit amount (0 if not applied)
 * @property {number} taxOwed - Final Oregon tax owed (after all credits)
 * @property {number} refundCredit - Refundable portion of kicker if kicker > tax
 * @property {number} marginalBracket - Marginal tax rate
 * @property {number} effectiveRate - Effective tax rate on taxable income
 */

/**
 * @typedef {Object} TaxBracket
 * @property {number} min - Lower bound (inclusive)
 * @property {number} max - Upper bound (exclusive)
 * @property {number} rate - Tax rate as decimal
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Oregon standard deductions by filing status and year
 * @type {Record<number, Record<FilingStatus, number>>}
 */
const OREGON_STANDARD_DEDUCTIONS = {
  2025: {
    single: 2835,
    mfj: 5670,    // Typically 2x single
    hoh: 4545,    // Placeholder - verify actual
    mfs: 2835     // Same as single
  }
};

/**
 * Oregon tax brackets by filing status and year
 * @type {Record<number, Record<FilingStatus, TaxBracket[]>>}
 */
const OREGON_BRACKETS = {
  2025: {
    single: [
      { min: 0, max: 4400, rate: 0.0475 },
      { min: 4400, max: 11100, rate: 0.0675 },
      { min: 11100, max: 125000, rate: 0.0875 },
      { min: 125000, max: Infinity, rate: 0.099 }
    ],
    mfj: [
      { min: 0, max: 8800, rate: 0.0475 },
      { min: 8800, max: 22200, rate: 0.0675 },
      { min: 22200, max: 250000, rate: 0.0875 },
      { min: 250000, max: Infinity, rate: 0.099 }
    ],
    hoh: [
      { min: 0, max: 4400, rate: 0.0475 },
      { min: 4400, max: 11100, rate: 0.0675 },
      { min: 11100, max: 125000, rate: 0.0875 },
      { min: 125000, max: Infinity, rate: 0.099 }
    ],
    mfs: [
      { min: 0, max: 4400, rate: 0.0475 },
      { min: 4400, max: 11100, rate: 0.0675 },
      { min: 11100, max: 125000, rate: 0.0875 },
      { min: 125000, max: Infinity, rate: 0.099 }
    ]
  }
};

/**
 * Oregon exemption credits by filing status and year
 * @type {Record<number, Record<FilingStatus, number>>}
 */
const OREGON_EXEMPTION_CREDITS = {
  2025: {
    single: 256,
    mfj: 512,     // Typically 2x single
    hoh: 256,
    mfs: 256
  }
};

/**
 * Oregon exemption credit AGI thresholds by filing status
 * @type {Record<FilingStatus, number>}
 */
const OREGON_EXEMPTION_AGI_THRESHOLD = {
  single: 100000,
  mfj: 200000,
  hoh: 100000,
  mfs: 100000
};

/**
 * Oregon kicker rate for 2025 (based on 2024 taxes)
 * @type {number}
 */
const OREGON_KICKER_RATE_2025 = 0.09863;

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

/**
 * Calculate progressive tax using bracket table
 * @param {number} taxableIncome
 * @param {TaxBracket[]} brackets
 * @returns {{tax: number, marginalBracket: number}}
 */
function calculateProgressiveTax(taxableIncome, brackets) {
  if (taxableIncome <= 0) {
    return { tax: 0, marginalBracket: brackets[0].rate };
  }

  let tax = 0;
  let marginalBracket = brackets[0].rate;

  for (const bracket of brackets) {
    if (taxableIncome <= bracket.min) {
      break;
    }

    const incomeInBracket = Math.min(taxableIncome, bracket.max) - bracket.min;
    if (incomeInBracket > 0) {
      tax += incomeInBracket * bracket.rate;
      marginalBracket = bracket.rate;
    }
  }

  return { tax, marginalBracket };
}

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Get Oregon standard deduction for a given year and filing status
 *
 * @param {number} taxYear - Tax year
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {number} Standard deduction amount
 */
function getOregonStandardDeduction(taxYear, filingStatus) {
  const yearData = OREGON_STANDARD_DEDUCTIONS[taxYear];
  if (!yearData) {
    throw new Error(`Oregon standard deduction not available for year ${taxYear}`);
  }

  const deduction = yearData[filingStatus];
  if (deduction === undefined) {
    throw new Error(`Oregon standard deduction not found for filing status: ${filingStatus}`);
  }

  return deduction;
}

/**
 * Get Oregon tax brackets for a given year and filing status
 *
 * @param {number} taxYear - Tax year
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {TaxBracket[]} Tax brackets
 */
function getOregonBrackets(taxYear, filingStatus) {
  const yearData = OREGON_BRACKETS[taxYear];
  if (!yearData) {
    throw new Error(`Oregon brackets not available for year ${taxYear}`);
  }

  const brackets = yearData[filingStatus];
  if (!brackets) {
    throw new Error(`Oregon brackets not found for filing status: ${filingStatus}`);
  }

  return brackets;
}

/**
 * Get Oregon exemption credit for a given year and filing status
 *
 * @param {number} taxYear - Tax year
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {number} Exemption credit amount
 */
function getOregonExemptionCredit(taxYear, filingStatus) {
  const yearData = OREGON_EXEMPTION_CREDITS[taxYear];
  if (!yearData) {
    throw new Error(`Oregon exemption credit not available for year ${taxYear}`);
  }

  const credit = yearData[filingStatus];
  if (credit === undefined) {
    throw new Error(`Oregon exemption credit not found for filing status: ${filingStatus}`);
  }

  return credit;
}

/**
 * Check if AGI qualifies for Oregon exemption credit
 *
 * @param {number} agi - Adjusted Gross Income
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {boolean} True if eligible for exemption credit
 */
function isExemptionCreditEligible(agi, filingStatus) {
  const threshold = OREGON_EXEMPTION_AGI_THRESHOLD[filingStatus];
  return agi < threshold;
}

/**
 * Calculate Oregon kicker credit
 *
 * @param {number} or40Line24 - 2024 OR-40 line 24 (total tax before credits)
 * @param {number} [kickerRate=OREGON_KICKER_RATE_2025] - Kicker rate
 * @returns {number} Kicker credit amount
 */
function calculateKicker(or40Line24, kickerRate = OREGON_KICKER_RATE_2025) {
  if (or40Line24 <= 0) {
    return 0;
  }
  return roundToCents(or40Line24 * kickerRate);
}

/**
 * Calculate Oregon income tax
 *
 * @param {OregonInputs} inputs - Oregon tax inputs
 * @returns {OregonTaxResult} Oregon tax calculation result
 */
function calcOregonTax(inputs) {
  const {
    taxYear,
    filingStatus,
    agi,
    deduction,
    exemptionCreditEligible = isExemptionCreditEligible(agi, filingStatus),
    applyKicker = false,
    or40Line24TotalTaxBeforeCredits = 0
  } = inputs;

  // Validate tax year
  if (taxYear !== 2025) {
    throw new Error(`Oregon tax year ${taxYear} is not implemented. Only 2025 is currently supported.`);
  }

  // Validate filing status (only single fully implemented)
  const validStatuses = ['single', 'mfj', 'hoh', 'mfs'];
  if (!validStatuses.includes(filingStatus)) {
    throw new Error(`Invalid filing status: ${filingStatus}`);
  }

  // Get brackets
  const brackets = getOregonBrackets(taxYear, filingStatus);

  // Calculate taxable income
  const taxableIncome = Math.max(0, agi - deduction);

  // Calculate tax from brackets
  const { tax: taxBeforeCredits, marginalBracket } = calculateProgressiveTax(taxableIncome, brackets);

  // Apply exemption credit
  let exemptionCredit = 0;
  if (exemptionCreditEligible) {
    exemptionCredit = getOregonExemptionCredit(taxYear, filingStatus);
  }
  const taxAfterExemption = roundToCents(Math.max(0, taxBeforeCredits - exemptionCredit));

  // Apply kicker (refundable credit)
  let kickerCredit = 0;
  let taxOwed = taxAfterExemption;
  let refundCredit = 0;

  if (applyKicker && or40Line24TotalTaxBeforeCredits > 0) {
    kickerCredit = calculateKicker(or40Line24TotalTaxBeforeCredits);
    taxOwed = roundToCents(Math.max(0, taxAfterExemption - kickerCredit));
    refundCredit = roundToCents(Math.max(0, kickerCredit - taxAfterExemption));
  }

  // Calculate effective rate
  const effectiveRate = taxableIncome > 0 ? taxOwed / taxableIncome : 0;

  return {
    taxableIncome,
    taxBeforeCredits: roundToCents(taxBeforeCredits),
    exemptionCredit,
    taxAfterExemption,
    kickerCredit,
    taxOwed,
    refundCredit,
    marginalBracket,
    effectiveRate
  };
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Main calculation function
  calcOregonTax,

  // Helper functions
  getOregonStandardDeduction,
  getOregonBrackets,
  getOregonExemptionCredit,
  isExemptionCreditEligible,
  calculateKicker,
  calculateProgressiveTax,
  roundToCents,

  // Constants
  OREGON_STANDARD_DEDUCTIONS,
  OREGON_BRACKETS,
  OREGON_EXEMPTION_CREDITS,
  OREGON_EXEMPTION_AGI_THRESHOLD,
  OREGON_KICKER_RATE_2025
};
