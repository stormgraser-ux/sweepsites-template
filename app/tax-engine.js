/**
 * Tax Engine Module (Browser-compatible version)
 * Centralized tax calculation functions for federal and Oregon income tax estimation.
 *
 * This file is a browser-compatible version of /tax/engine.js + /tax/oregon.js
 * Exposes TaxEngine global object for use in taxes.html
 */

(function(global) {
  'use strict';

  // =============================================================================
  // Federal Constants
  // =============================================================================

  const FEDERAL_STANDARD_DEDUCTIONS = {
    2025: {
      single: 15750,
      mfj: 31500,
      hoh: 23625,
      mfs: 15750
    }
  };

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

  // =============================================================================
  // Oregon Constants
  // =============================================================================

  const OREGON_STANDARD_DEDUCTIONS = {
    2025: {
      single: 2835,
      mfj: 5670,
      hoh: 4545,
      mfs: 2835
    }
  };

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

  const OREGON_EXEMPTION_CREDITS = {
    2025: {
      single: 256,
      mfj: 512,
      hoh: 256,
      mfs: 256
    }
  };

  const OREGON_EXEMPTION_AGI_THRESHOLD = {
    single: 100000,
    mfj: 200000,
    hoh: 100000,
    mfs: 100000
  };

  const OREGON_KICKER_RATE_2025 = 0.09863;

  // =============================================================================
  // Federal Credits Constants (2025)
  // =============================================================================

  const CTC_AMOUNT_2025 = 2000;
  const ODC_AMOUNT_2025 = 500;
  const CTC_PHASEOUT_THRESHOLDS = {
    single: 200000,
    mfj: 400000,
    hoh: 200000,
    mfs: 200000
  };
  const PHASEOUT_RATE_PER_1000 = 50;

  const FEATURE_FLAGS = {
    MFS_ENABLED: false
  };

  // =============================================================================
  // Helper Functions
  // =============================================================================

  function roundToCents(value) {
    return Math.round(value * 100) / 100;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

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
  // Federal Tax Functions
  // =============================================================================

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

  function calcFederalTax(inputs) {
    const { taxYear, filingStatus, agi, deduction } = inputs;

    if (taxYear !== 2025) {
      throw new Error(`Tax year ${taxYear} is not implemented.`);
    }

    const validStatuses = ['single', 'mfj', 'hoh'];
    if (FEATURE_FLAGS.MFS_ENABLED) {
      validStatuses.push('mfs');
    }

    if (!validStatuses.includes(filingStatus)) {
      throw new Error(`Invalid filing status: ${filingStatus}`);
    }

    const brackets = FEDERAL_BRACKETS[taxYear][filingStatus];
    const taxableIncome = Math.max(0, agi - deduction);
    const { tax, marginalBracket } = calculateProgressiveTax(taxableIncome, brackets);
    const effectiveRate = taxableIncome > 0 ? tax / taxableIncome : 0;

    return { taxableIncome, tax, marginalBracket, effectiveRate };
  }

  function calcFederalFromDomain(inputs) {
    const { taxYear, filingStatus, domain, capitalLossUsed = 0 } = inputs;

    const {
      redemptionsReceived = 0,
      redemptionsPending = 0,
      purchasesTotal = 0,
      includePending = false,
      treatment = 'sweepstakes',
      otherItemizedDeductions = 0
    } = domain;

    const grossIncome = redemptionsReceived + (includePending ? redemptionsPending : 0);
    const clampedCapitalLoss = clamp(capitalLossUsed, 0, 3000);
    const agi = Math.max(0, grossIncome - clampedCapitalLoss);
    const standardDeduction = getStandardDeduction(taxYear, filingStatus);

    let deductionUsed;
    let deductionMethod;
    let gamblingLossDeduction = 0;
    let itemizedDeduction = 0;

    if (treatment === 'sweepstakes') {
      deductionUsed = standardDeduction;
      deductionMethod = 'standard';
    } else {
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

    const taxableIncome = Math.max(0, agi - deductionUsed);
    const taxResult = calcFederalTax({ taxYear, filingStatus, agi, deduction: deductionUsed });

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
  // Oregon Tax Functions
  // =============================================================================

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

  function getOregonExemptionCredit(taxYear, filingStatus) {
    const yearData = OREGON_EXEMPTION_CREDITS[taxYear];
    if (!yearData) {
      throw new Error(`Oregon exemption credit not available for year ${taxYear}`);
    }
    return yearData[filingStatus] || 0;
  }

  function isExemptionCreditEligible(agi, filingStatus) {
    const threshold = OREGON_EXEMPTION_AGI_THRESHOLD[filingStatus] || 100000;
    return agi < threshold;
  }

  function calculateKicker(or40Line24, kickerRate = OREGON_KICKER_RATE_2025) {
    if (or40Line24 <= 0) return 0;
    return roundToCents(or40Line24 * kickerRate);
  }

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

    if (taxYear !== 2025) {
      throw new Error(`Oregon tax year ${taxYear} is not implemented.`);
    }

    const brackets = getOregonBrackets(taxYear, filingStatus);
    const taxableIncome = Math.max(0, agi - deduction);
    const { tax: taxBeforeCredits, marginalBracket } = calculateProgressiveTax(taxableIncome, brackets);

    let exemptionCredit = 0;
    if (exemptionCreditEligible) {
      exemptionCredit = getOregonExemptionCredit(taxYear, filingStatus);
    }
    const taxAfterExemption = roundToCents(Math.max(0, taxBeforeCredits - exemptionCredit));

    let kickerCredit = 0;
    let taxOwed = taxAfterExemption;
    let refundCredit = 0;

    if (applyKicker && or40Line24TotalTaxBeforeCredits > 0) {
      kickerCredit = calculateKicker(or40Line24TotalTaxBeforeCredits);
      taxOwed = roundToCents(Math.max(0, taxAfterExemption - kickerCredit));
      refundCredit = roundToCents(Math.max(0, kickerCredit - taxAfterExemption));
    }

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

    const oregonStandardDeduction = getOregonStandardDeduction(taxYear, filingStatus);

    let deductionUsed;
    let deductionMethod;

    if (federalDeductionMethod === 'standard') {
      deductionUsed = oregonStandardDeduction;
      deductionMethod = 'standard';
    } else {
      deductionUsed = federalDeductionUsed;
      deductionMethod = 'itemized';
    }

    const oregonResult = calcOregonTax({
      taxYear,
      filingStatus,
      agi,
      deduction: deductionUsed,
      exemptionCreditEligible: isExemptionCreditEligible(agi, filingStatus),
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
  // Federal Credits Functions
  // =============================================================================

  function calculatePhaseout(agi, filingStatus, totalCredits) {
    const threshold = CTC_PHASEOUT_THRESHOLDS[filingStatus] || 200000;

    if (agi <= threshold) {
      return 0;
    }

    const excessAgi = agi - threshold;
    const thousandsAbove = Math.ceil(excessAgi / 1000);
    const phaseout = thousandsAbove * PHASEOUT_RATE_PER_1000;

    return Math.min(phaseout, totalCredits);
  }

  function getPhaseoutThreshold(filingStatus) {
    return CTC_PHASEOUT_THRESHOLDS[filingStatus] || 200000;
  }

  function calcFederalCredits(inputs) {
    const {
      filingStatus,
      agi,
      federalTaxBeforeCredits,
      dependents,
      applyPhaseout = false
    } = inputs;

    const totalDependents = Math.max(0, Math.floor(dependents.dependents || 0));
    const childrenUnder17 = Math.max(0, Math.min(
      Math.floor(dependents.childrenUnder17 || 0),
      totalDependents
    ));
    const otherDependents = totalDependents - childrenUnder17;

    const childTaxCreditFull = childrenUnder17 * CTC_AMOUNT_2025;
    const otherDependentCreditFull = otherDependents * ODC_AMOUNT_2025;
    const totalCreditsFull = childTaxCreditFull + otherDependentCreditFull;

    let phaseoutAmount = 0;
    if (applyPhaseout && totalCreditsFull > 0) {
      phaseoutAmount = calculatePhaseout(agi, filingStatus, totalCreditsFull);
    }

    const totalCreditsAfterPhaseout = Math.max(0, totalCreditsFull - phaseoutAmount);

    const nonrefundableCreditsApplied = Math.min(
      totalCreditsAfterPhaseout,
      Math.max(0, federalTaxBeforeCredits)
    );

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

  // =============================================================================
  // Combined Federal + Oregon Calculation
  // =============================================================================

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

    const federal = calcFederalFromDomain({ taxYear, filingStatus, domain, capitalLossUsed });

    // Calculate federal credits if dependents provided
    let federalCredits = null;
    let federalTaxAfterCredits = federal.federalTax;

    if (dependents && (dependents.dependents > 0 || dependents.childrenUnder17 > 0)) {
      federalCredits = calcFederalCredits({
        filingStatus,
        agi: federal.agi,
        federalTaxBeforeCredits: federal.federalTax,
        dependents,
        applyPhaseout: applyCreditsPhaseout
      });
      federalTaxAfterCredits = federalCredits.federalTaxAfterCredits;
    }

    const oregonCalc = calcOregonFromDomain({
      taxYear,
      filingStatus,
      agi: federal.agi,
      federalDeductionUsed: federal.deductionUsed,
      federalDeductionMethod: federal.deductionMethod,
      applyKicker,
      or40Line24
    });

    const totalTaxLiability = roundToCents(federalTaxAfterCredits + oregonCalc.taxOwed);
    const totalRefundCredit = oregonCalc.refundCredit;
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
  // Feature Flags
  // =============================================================================

  function isMfsEnabled() {
    return FEATURE_FLAGS.MFS_ENABLED;
  }

  function setMfsEnabled(enabled) {
    FEATURE_FLAGS.MFS_ENABLED = enabled;
  }

  // =============================================================================
  // Export as global TaxEngine object
  // =============================================================================

  global.TaxEngine = {
    // Federal
    calcFederalTax,
    calcFederalFromDomain,
    getStandardDeduction,
    getBrackets,
    FEDERAL_STANDARD_DEDUCTIONS,
    FEDERAL_BRACKETS,

    // Federal Credits
    calcFederalCredits,
    calculatePhaseout,
    getPhaseoutThreshold,
    CTC_AMOUNT_2025,
    ODC_AMOUNT_2025,
    CTC_PHASEOUT_THRESHOLDS,
    PHASEOUT_RATE_PER_1000,

    // Oregon
    calcOregonTax,
    calcOregonFromDomain,
    getOregonStandardDeduction,
    getOregonBrackets,
    getOregonExemptionCredit,
    isExemptionCreditEligible,
    calculateKicker,
    OREGON_STANDARD_DEDUCTIONS,
    OREGON_BRACKETS,
    OREGON_EXEMPTION_CREDITS,
    OREGON_KICKER_RATE_2025,

    // Combined
    calcCombinedFromDomain,

    // Utilities
    calculateProgressiveTax,
    roundToCents,
    clamp,
    isMfsEnabled,
    setMfsEnabled
  };

})(typeof window !== 'undefined' ? window : this);
