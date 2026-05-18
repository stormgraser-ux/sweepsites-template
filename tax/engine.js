/**
 * Tax Engine Module
 * Centralized tax calculation functions for federal and state income tax estimation.
 *
 * @module tax/engine
 */

// Import Oregon module
const oregon = require('./oregon.js');

// Import Credits module
const credits = require('./credits.js');

/**
 * @typedef {'single' | 'mfj' | 'hoh' | 'mfs'} FilingStatus
 */

/**
 * @typedef {Object} FederalInputs
 * @property {2025} taxYear - Tax year (currently only 2025 supported)
 * @property {FilingStatus} filingStatus - Filing status
 * @property {number} agi - Adjusted Gross Income
 * @property {number} deduction - Deduction amount (standard or itemized)
 */

/**
 * @typedef {Object} FederalTaxResult
 * @property {number} taxableIncome - AGI minus deduction (floored at 0)
 * @property {number} tax - Calculated tax amount (full precision)
 * @property {number} marginalBracket - Marginal tax rate as decimal (e.g., 0.22)
 * @property {number} effectiveRate - Effective tax rate as decimal
 */

/**
 * @typedef {Object} TaxBracket
 * @property {number} min - Lower bound of bracket (inclusive)
 * @property {number} max - Upper bound of bracket (exclusive)
 * @property {number} rate - Tax rate as decimal
 */

/**
 * @typedef {'sweepstakes' | 'gambling'} Treatment
 */

/**
 * @typedef {Object} DomainInputs
 * @property {number} redemptionsReceived - USD received from completed redemptions
 * @property {number} redemptionsPending - USD from pending redemptions
 * @property {number} purchasesTotal - Total USD spent on purchases
 * @property {boolean} [includePending=false] - Whether to include pending redemptions in gross income
 * @property {Treatment} [treatment='sweepstakes'] - Tax treatment method
 * @property {number} [otherItemizedDeductions=0] - Other itemized deductions (for gambling treatment)
 */

/**
 * @typedef {Object} DomainFederalInputs
 * @property {2025} taxYear - Tax year
 * @property {FilingStatus} filingStatus - Filing status
 * @property {DomainInputs} domain - Domain-specific inputs
 * @property {number} [capitalLossUsed=0] - Capital loss to reduce AGI (clamped 0-3000)
 */

/**
 * @typedef {'standard' | 'itemized'} DeductionMethod
 */

/**
 * @typedef {Object} DomainFederalResult
 * @property {number} grossIncome - Total redemptions included
 * @property {number} agi - Adjusted Gross Income (after capital loss)
 * @property {number} deductionUsed - Actual deduction amount used
 * @property {DeductionMethod} deductionMethod - Whether standard or itemized was used
 * @property {number} standardDeduction - Standard deduction for reference
 * @property {number} itemizedDeduction - Itemized deduction for reference (gambling only)
 * @property {number} gamblingLossDeduction - Gambling loss portion of itemized (gambling only)
 * @property {number} taxableIncome - AGI minus deduction
 * @property {number} federalTax - Calculated federal tax
 * @property {number} marginalBracket - Marginal tax rate
 * @property {number} effectiveRate - Effective tax rate on taxable income
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Federal standard deductions by filing status and year
 * @type {Record<number, Record<FilingStatus, number>>}
 */
const FEDERAL_STANDARD_DEDUCTIONS = {
  2025: {
    single: 15750,
    mfj: 31500,
    hoh: 23625,
    mfs: 15750
  }
};

/**
 * Federal tax brackets by filing status and year
 * Brackets are defined with min (inclusive) and max (exclusive)
 * @type {Record<number, Record<FilingStatus, TaxBracket[]>>}
 */
const FEDERAL_BRACKETS = {
  2025: {
    single: [
      { min: 0, max: 11925, rate: 0.10 },
      { min: 11925, max: 48475, rate: 0.12 },
      { min: 48475, max: 103350, rate: 0.22 },
      { min: 103350, max: 197300, rate: 0.24 },
      { min: 197300, max: 250525, rate: 0.32 },
      { min: 250525, max: 626350, rate: 0.35 },
      { min: 626350, max: Infinity, rate: 0.37 }
    ],
    mfj: [
      { min: 0, max: 23850, rate: 0.10 },
      { min: 23850, max: 96950, rate: 0.12 },
      { min: 96950, max: 206700, rate: 0.22 },
      { min: 206700, max: 394600, rate: 0.24 },
      { min: 394600, max: 501050, rate: 0.32 },
      { min: 501050, max: 751600, rate: 0.35 },
      { min: 751600, max: Infinity, rate: 0.37 }
    ],
    hoh: [
      { min: 0, max: 17000, rate: 0.10 },
      { min: 17000, max: 64850, rate: 0.12 },
      { min: 64850, max: 103350, rate: 0.22 },
      { min: 103350, max: 197300, rate: 0.24 },
      { min: 197300, max: 250500, rate: 0.32 },
      { min: 250500, max: 626350, rate: 0.35 },
      { min: 626350, max: Infinity, rate: 0.37 }
    ],
    mfs: [
      { min: 0, max: 11925, rate: 0.10 },
      { min: 11925, max: 48475, rate: 0.12 },
      { min: 48475, max: 103350, rate: 0.22 },
      { min: 103350, max: 197300, rate: 0.24 },
      { min: 197300, max: 250525, rate: 0.32 },
      { min: 250525, max: 375800, rate: 0.35 },
      { min: 375800, max: Infinity, rate: 0.37 }
    ]
  }
};

/**
 * Feature flags
 */
const FEATURE_FLAGS = {
  MFS_ENABLED: false // Set to true to enable MFS filing status
};

// =============================================================================
// Tax Calculation Functions
// =============================================================================

/**
 * Calculate progressive tax using bracket table
 * Computes tax by applying each bracket's rate to the portion of income within that bracket.
 *
 * @param {number} taxableIncome - Taxable income (must be >= 0)
 * @param {TaxBracket[]} brackets - Array of tax brackets
 * @returns {{tax: number, marginalBracket: number}} Tax amount and marginal bracket rate
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

/**
 * Calculate federal income tax
 *
 * @param {FederalInputs} inputs - Tax calculation inputs
 * @returns {FederalTaxResult} Calculated tax result
 * @throws {Error} If filing status is not supported or tax year is not implemented
 */
function calcFederalTax(inputs) {
  const { taxYear, filingStatus, agi, deduction } = inputs;

  // Validate tax year
  if (taxYear !== 2025) {
    throw new Error(`Tax year ${taxYear} is not implemented. Only 2025 is currently supported.`);
  }

  // Validate filing status
  const validStatuses = ['single', 'mfj', 'hoh'];
  if (FEATURE_FLAGS.MFS_ENABLED) {
    validStatuses.push('mfs');
  }

  if (!validStatuses.includes(filingStatus)) {
    if (filingStatus === 'mfs' && !FEATURE_FLAGS.MFS_ENABLED) {
      throw new Error('MFS filing status is currently disabled. Enable FEATURE_FLAGS.MFS_ENABLED to use it.');
    }
    throw new Error(`Invalid filing status: ${filingStatus}. Valid options: ${validStatuses.join(', ')}`);
  }

  // Get brackets for this filing status and year
  const brackets = FEDERAL_BRACKETS[taxYear][filingStatus];
  if (!brackets) {
    throw new Error(`No bracket data for ${filingStatus} in ${taxYear}`);
  }

  // Calculate taxable income (cannot be negative)
  const taxableIncome = Math.max(0, agi - deduction);

  // Calculate tax using progressive brackets
  const { tax, marginalBracket } = calculateProgressiveTax(taxableIncome, brackets);

  // Calculate effective rate (avoid division by zero)
  const effectiveRate = taxableIncome > 0 ? tax / taxableIncome : 0;

  return {
    taxableIncome,
    tax,
    marginalBracket,
    effectiveRate
  };
}

/**
 * Get the federal standard deduction for a given year and filing status
 *
 * @param {number} taxYear - Tax year
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {number} Standard deduction amount
 * @throws {Error} If year or filing status not found
 */
function getStandardDeduction(taxYear, filingStatus) {
  const yearData = FEDERAL_STANDARD_DEDUCTIONS[taxYear];
  if (!yearData) {
    throw new Error(`Standard deduction data not available for year ${taxYear}`);
  }

  const deduction = yearData[filingStatus];
  if (deduction === undefined) {
    throw new Error(`Standard deduction not found for filing status: ${filingStatus}`);
  }

  return deduction;
}

/**
 * Get the federal tax brackets for a given year and filing status
 *
 * @param {number} taxYear - Tax year
 * @param {FilingStatus} filingStatus - Filing status
 * @returns {TaxBracket[]} Array of tax brackets
 * @throws {Error} If year or filing status not found
 */
function getBrackets(taxYear, filingStatus) {
  const yearData = FEDERAL_BRACKETS[taxYear];
  if (!yearData) {
    throw new Error(`Bracket data not available for year ${taxYear}`);
  }

  const brackets = yearData[filingStatus];
  if (!brackets) {
    throw new Error(`Brackets not found for filing status: ${filingStatus}`);
  }

  return brackets;
}

/**
 * Round to cents (2 decimal places) for display purposes
 *
 * @param {number} value - Value to round
 * @returns {number} Value rounded to 2 decimal places
 */
function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Check if MFS filing status is enabled
 *
 * @returns {boolean} True if MFS is enabled
 */
function isMfsEnabled() {
  return FEATURE_FLAGS.MFS_ENABLED;
}

/**
 * Enable or disable MFS filing status (for testing)
 *
 * @param {boolean} enabled - Whether to enable MFS
 */
function setMfsEnabled(enabled) {
  FEATURE_FLAGS.MFS_ENABLED = enabled;
}

// =============================================================================
// Domain-Aware Federal Tax Calculation
// =============================================================================

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculate federal tax from domain-specific inputs (sweepstakes/gambling)
 *
 * This function handles the business logic for:
 * - Sweepstakes treatment: uses standard deduction only
 * - Gambling treatment: compares itemized (gambling losses + other) vs standard, uses higher
 *
 * @param {DomainFederalInputs} inputs - Domain-aware tax inputs
 * @returns {DomainFederalResult} Complete breakdown of federal tax calculation
 */
function calcFederalFromDomain(inputs) {
  const { taxYear, filingStatus, domain, capitalLossUsed = 0 } = inputs;

  // Extract domain inputs with defaults
  const {
    redemptionsReceived = 0,
    redemptionsPending = 0,
    purchasesTotal = 0,
    includePending = false,
    treatment = 'sweepstakes',
    otherItemizedDeductions = 0
  } = domain;

  // Calculate gross income
  const grossIncome = redemptionsReceived + (includePending ? redemptionsPending : 0);

  // Apply capital loss (clamped to 0-3000)
  const clampedCapitalLoss = clamp(capitalLossUsed, 0, 3000);
  const agi = Math.max(0, grossIncome - clampedCapitalLoss);

  // Get standard deduction for this filing status
  const standardDeduction = getStandardDeduction(taxYear, filingStatus);

  // Calculate deduction based on treatment
  let deductionUsed;
  let deductionMethod;
  let gamblingLossDeduction = 0;
  let itemizedDeduction = 0;

  if (treatment === 'sweepstakes') {
    // Sweepstakes: always use standard deduction (purchases not deductible)
    deductionUsed = standardDeduction;
    deductionMethod = 'standard';
  } else {
    // Gambling: compare itemized vs standard, use higher
    // Gambling losses are limited to gambling winnings (gross income)
    gamblingLossDeduction = Math.min(purchasesTotal, grossIncome);
    itemizedDeduction = gamblingLossDeduction + otherItemizedDeductions;

    if (itemizedDeduction > standardDeduction) {
      deductionUsed = itemizedDeduction;
      deductionMethod = 'itemized';
    } else {
      deductionUsed = standardDeduction;
      deductionMethod = 'standard';
    }
  }

  // Calculate taxable income
  const taxableIncome = Math.max(0, agi - deductionUsed);

  // Calculate federal tax using the core function
  const taxResult = calcFederalTax({
    taxYear,
    filingStatus,
    agi,
    deduction: deductionUsed
  });

  return {
    grossIncome,
    agi,
    deductionUsed,
    deductionMethod,
    standardDeduction,
    itemizedDeduction,
    gamblingLossDeduction,
    taxableIncome,
    federalTax: taxResult.tax,
    marginalBracket: taxResult.marginalBracket,
    effectiveRate: taxResult.effectiveRate
  };
}

// =============================================================================
// Oregon Domain-Aware Calculation
// =============================================================================

/**
 * @typedef {Object} OregonDomainInputs
 * @property {2025} taxYear - Tax year
 * @property {FilingStatus} filingStatus - Filing status
 * @property {number} agi - Adjusted Gross Income (same as federal)
 * @property {number} federalDeductionUsed - Deduction amount used for federal
 * @property {DeductionMethod} federalDeductionMethod - 'standard' or 'itemized'
 * @property {boolean} [applyKicker=false] - Whether to apply Oregon kicker
 * @property {number} [or40Line24=0] - 2024 OR-40 line 24 for kicker calculation
 */

/**
 * @typedef {Object} OregonDomainResult
 * @property {number} oregonStandardDeduction - Oregon standard deduction for reference
 * @property {number} deductionUsed - Actual Oregon deduction used
 * @property {DeductionMethod} deductionMethod - Whether standard or itemized was used
 * @property {number} taxableIncome - Oregon taxable income
 * @property {number} taxBeforeCredits - Tax from brackets
 * @property {number} exemptionCredit - Exemption credit applied
 * @property {number} taxAfterExemption - Tax after exemption
 * @property {number} kickerCredit - Kicker credit applied
 * @property {number} taxOwed - Final Oregon tax owed
 * @property {number} refundCredit - Refundable kicker portion
 * @property {number} marginalBracket - Oregon marginal bracket
 */

/**
 * Calculate Oregon tax from domain inputs.
 *
 * DEDUCTION LOGIC (mirrors federal):
 * - If federal used standard: Oregon uses Oregon's standard deduction
 * - If federal used itemized: Oregon uses the same itemized amount
 *
 * This keeps the logic simple and consistent between jurisdictions.
 *
 * @param {OregonDomainInputs} inputs - Oregon domain inputs
 * @returns {OregonDomainResult} Oregon tax calculation result
 */
function calcOregonFromDomain(inputs) {
  const {
    taxYear,
    filingStatus,
    agi,
    federalDeductionUsed,
    federalDeductionMethod,
    applyKicker = false,
    or40Line24 = 0
  } = inputs;

  // Get Oregon standard deduction
  const oregonStandardDeduction = oregon.getOregonStandardDeduction(taxYear, filingStatus);

  // Determine Oregon deduction based on federal method
  let deductionUsed;
  let deductionMethod;

  if (federalDeductionMethod === 'standard') {
    // Federal used standard -> Oregon uses Oregon's standard
    deductionUsed = oregonStandardDeduction;
    deductionMethod = 'standard';
  } else {
    // Federal used itemized -> Oregon uses same itemized amount
    // (Taxpayer would itemize on both returns)
    deductionUsed = federalDeductionUsed;
    deductionMethod = 'itemized';
  }

  // Calculate Oregon tax
  const oregonResult = oregon.calcOregonTax({
    taxYear,
    filingStatus,
    agi,
    deduction: deductionUsed,
    exemptionCreditEligible: oregon.isExemptionCreditEligible(agi, filingStatus),
    applyKicker,
    or40Line24TotalTaxBeforeCredits: or40Line24
  });

  return {
    oregonStandardDeduction,
    deductionUsed,
    deductionMethod,
    taxableIncome: oregonResult.taxableIncome,
    taxBeforeCredits: oregonResult.taxBeforeCredits,
    exemptionCredit: oregonResult.exemptionCredit,
    taxAfterExemption: oregonResult.taxAfterExemption,
    kickerCredit: oregonResult.kickerCredit,
    taxOwed: oregonResult.taxOwed,
    refundCredit: oregonResult.refundCredit,
    marginalBracket: oregonResult.marginalBracket
  };
}

// =============================================================================
// Combined Federal + Oregon Calculation
// =============================================================================

/**
 * @typedef {Object} DependentsInputs
 * @property {number} dependents - Total number of dependents (integer >= 0)
 * @property {number} childrenUnder17 - Number of qualifying children under 17 (<= dependents)
 */

/**
 * @typedef {Object} CombinedDomainInputs
 * @property {2025} taxYear - Tax year
 * @property {FilingStatus} filingStatus - Filing status
 * @property {DomainInputs} domain - Domain-specific inputs (redemptions, purchases, treatment)
 * @property {number} [capitalLossUsed=0] - Capital loss to reduce AGI
 * @property {boolean} [applyKicker=false] - Whether to apply Oregon kicker (Advanced)
 * @property {number} [or40Line24=0] - 2024 OR-40 line 24 for kicker (Advanced)
 * @property {DependentsInputs} [dependents] - Dependents for federal credits
 * @property {boolean} [applyCreditsPhaseout=false] - Whether to apply CTC/ODC phaseout
 */

/**
 * @typedef {Object} FederalCreditsResult
 * @property {number} childTaxCreditFull - Full CTC before phaseout
 * @property {number} otherDependentCreditFull - Full ODC before phaseout
 * @property {number} totalCreditsFull - Total credits before phaseout
 * @property {number} phaseoutAmount - Amount reduced due to phaseout
 * @property {number} totalCreditsAfterPhaseout - Credits after phaseout
 * @property {number} nonrefundableCreditsApplied - Credits actually applied
 * @property {number} federalTaxAfterCredits - Federal tax after credits
 */

/**
 * @typedef {Object} CombinedTaxResult
 * @property {number} grossIncome - Total redemptions included
 * @property {number} agi - Adjusted Gross Income
 * @property {Treatment} treatment - Tax treatment used
 * @property {DomainFederalResult} federal - Federal tax breakdown
 * @property {FederalCreditsResult} [federalCredits] - Federal credits breakdown (if dependents provided)
 * @property {OregonDomainResult} oregon - Oregon tax breakdown
 * @property {number} totalTaxLiability - Federal + Oregon taxes owed (minus refund credits)
 * @property {number} totalRefundCredit - Total refundable credits
 * @property {number} effectiveRate - Combined effective rate on gross income
 */

/**
 * Calculate both federal and Oregon taxes from domain inputs.
 *
 * Returns a complete breakdown of both federal and state taxes with a combined summary.
 * If dependents are provided, also calculates federal credits (CTC/ODC).
 *
 * @param {CombinedDomainInputs} inputs - Combined inputs for both jurisdictions
 * @returns {CombinedTaxResult} Complete tax calculation for federal + Oregon
 */
function calcCombinedFromDomain(inputs) {
  const {
    taxYear,
    filingStatus,
    domain,
    capitalLossUsed = 0,
    applyKicker = false,
    or40Line24 = 0,
    dependents = null,
    applyCreditsPhaseout = false
  } = inputs;

  // Calculate federal first
  const federal = calcFederalFromDomain({
    taxYear,
    filingStatus,
    domain,
    capitalLossUsed
  });

  // Calculate federal credits if dependents provided
  let federalCredits = null;
  let federalTaxAfterCredits = federal.federalTax;

  if (dependents && (dependents.dependents > 0 || dependents.childrenUnder17 > 0)) {
    federalCredits = credits.calcFederalCredits({
      filingStatus,
      agi: federal.agi,
      federalTaxBeforeCredits: federal.federalTax,
      dependents,
      applyPhaseout: applyCreditsPhaseout
    });
    federalTaxAfterCredits = federalCredits.federalTaxAfterCredits;
  }

  // Calculate Oregon using federal's deduction method
  const oregonCalc = calcOregonFromDomain({
    taxYear,
    filingStatus,
    agi: federal.agi,
    federalDeductionUsed: federal.deductionUsed,
    federalDeductionMethod: federal.deductionMethod,
    applyKicker,
    or40Line24
  });

  // Calculate totals (use federalTaxAfterCredits if credits applied)
  const totalTaxLiability = roundToCents(federalTaxAfterCredits + oregonCalc.taxOwed);
  const totalRefundCredit = oregonCalc.refundCredit;

  // Effective rate on gross income (what you actually pay as % of winnings)
  const effectiveRate = federal.grossIncome > 0
    ? (totalTaxLiability - totalRefundCredit) / federal.grossIncome
    : 0;

  const result = {
    grossIncome: federal.grossIncome,
    agi: federal.agi,
    treatment: domain.treatment || 'sweepstakes',
    federal,
    oregon: oregonCalc,
    totalTaxLiability,
    totalRefundCredit,
    effectiveRate
  };

  if (federalCredits) {
    result.federalCredits = federalCredits;
  }

  return result;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Main calculation functions
  calcFederalTax,
  calcFederalFromDomain,
  calcOregonFromDomain,
  calcCombinedFromDomain,

  // Helper functions
  calculateProgressiveTax,
  getStandardDeduction,
  getBrackets,
  roundToCents,
  clamp,

  // Feature flag functions
  isMfsEnabled,
  setMfsEnabled,

  // Federal constants
  FEDERAL_STANDARD_DEDUCTIONS,
  FEDERAL_BRACKETS,

  // Credits module re-exports
  credits: {
    calcFederalCredits: credits.calcFederalCredits,
    calculatePhaseout: credits.calculatePhaseout,
    getPhaseoutThreshold: credits.getPhaseoutThreshold,
    CTC_AMOUNT_2025: credits.CTC_AMOUNT_2025,
    ODC_AMOUNT_2025: credits.ODC_AMOUNT_2025,
    CTC_PHASEOUT_THRESHOLDS: credits.CTC_PHASEOUT_THRESHOLDS,
    PHASEOUT_RATE_PER_1000: credits.PHASEOUT_RATE_PER_1000
  },

  // Oregon module re-exports
  oregon: {
    calcOregonTax: oregon.calcOregonTax,
    getOregonStandardDeduction: oregon.getOregonStandardDeduction,
    getOregonBrackets: oregon.getOregonBrackets,
    getOregonExemptionCredit: oregon.getOregonExemptionCredit,
    isExemptionCreditEligible: oregon.isExemptionCreditEligible,
    calculateKicker: oregon.calculateKicker,
    OREGON_STANDARD_DEDUCTIONS: oregon.OREGON_STANDARD_DEDUCTIONS,
    OREGON_BRACKETS: oregon.OREGON_BRACKETS,
    OREGON_EXEMPTION_CREDITS: oregon.OREGON_EXEMPTION_CREDITS,
    OREGON_KICKER_RATE_2025: oregon.OREGON_KICKER_RATE_2025
  }
};
