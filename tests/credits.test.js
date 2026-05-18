/**
 * Federal Credits Unit Tests
 * Tests for CTC and ODC calculations with simplified model.
 */

const TaxEngine = require('../tax/engine.js');
const credits = require('../tax/credits.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('✓', name);
    passed++;
  } catch (e) {
    console.log('✗', name);
    console.log('  Error:', e.message);
    failed++;
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
  }
}

function assertClose(actual, expected, tolerance = 0.01, message = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Expected ${expected} ± ${tolerance}, got ${actual}. ${message}`);
  }
}

console.log('\n========================================');
console.log('Federal Credits Unit Tests');
console.log('========================================\n');

// =============================================================================
// Test A: Single, federal tax ~$2,500, 1 dependent, 1 child under 17
// Credit should reduce tax by up to $2,000 (not below zero)
// =============================================================================

console.log('Test A: Single with 1 child under 17');

test('CTC for 1 child = $2,000', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 2500,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.childTaxCreditFull, 2000);
});

test('Total credits applied = $2,000 (limited by tax)', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 2500,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.nonrefundableCreditsApplied, 2000);
});

test('Federal tax after credits = $500', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 2500,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.federalTaxAfterCredits, 500);
});

// =============================================================================
// Test B: 2 dependents, 1 child under 17
// Credits = 2000 + 500 = 2500
// =============================================================================

console.log('\nTest B: 2 dependents (1 child + 1 other)');

test('CTC for 1 child = $2,000', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 2, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.childTaxCreditFull, 2000);
});

test('ODC for 1 other dependent = $500', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 2, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.otherDependentCreditFull, 500);
});

test('Total credits = $2,500', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 2, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.totalCreditsFull, 2500);
});

test('Federal tax after credits = $2,500', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 2, childrenUnder17: 1 },
    applyPhaseout: false
  });
  assertEqual(result.federalTaxAfterCredits, 2500);
});

// =============================================================================
// Test C: Credits cannot exceed federal tax (floor at 0)
// =============================================================================

console.log('\nTest C: Credits cannot exceed tax (floor at 0)');

test('Credits limited to tax liability', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 30000,
    federalTaxBeforeCredits: 1500,
    dependents: { dependents: 2, childrenUnder17: 2 }, // Would be $4,000 in credits
    applyPhaseout: false
  });
  assertEqual(result.totalCreditsFull, 4000);
  assertEqual(result.nonrefundableCreditsApplied, 1500); // Limited to tax
  assertEqual(result.federalTaxAfterCredits, 0);
});

test('Tax never goes negative', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'mfj',
    agi: 50000,
    federalTaxBeforeCredits: 1000,
    dependents: { dependents: 3, childrenUnder17: 3 }, // Would be $6,000 in credits
    applyPhaseout: false
  });
  assertEqual(result.federalTaxAfterCredits, 0);
});

// =============================================================================
// Test D: Phaseout calculations
// =============================================================================

console.log('\nTest D: Phaseout calculations');

test('No phaseout below threshold (single, AGI < $200k)', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 150000,
    federalTaxBeforeCredits: 20000,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyPhaseout: true
  });
  assertEqual(result.phaseoutAmount, 0);
  assertEqual(result.nonrefundableCreditsApplied, 2000);
});

test('No phaseout below threshold (MFJ, AGI < $400k)', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'mfj',
    agi: 350000,
    federalTaxBeforeCredits: 50000,
    dependents: { dependents: 2, childrenUnder17: 2 },
    applyPhaseout: true
  });
  assertEqual(result.phaseoutAmount, 0);
  assertEqual(result.nonrefundableCreditsApplied, 4000);
});

test('Phaseout applies at $205k single (5 * $50 = $250)', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 205000,
    federalTaxBeforeCredits: 30000,
    dependents: { dependents: 2, childrenUnder17: 2 }, // $4,000 full credits
    applyPhaseout: true
  });
  // $5,000 over threshold = 5 * $50 = $250 phaseout
  assertEqual(result.phaseoutAmount, 250);
  assertEqual(result.totalCreditsAfterPhaseout, 3750);
});

test('Phaseout applies at $420k MFJ (20 * $50 = $1,000)', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'mfj',
    agi: 420000,
    federalTaxBeforeCredits: 80000,
    dependents: { dependents: 3, childrenUnder17: 3 }, // $6,000 full credits
    applyPhaseout: true
  });
  // $20,000 over threshold = 20 * $50 = $1,000 phaseout
  assertEqual(result.phaseoutAmount, 1000);
  assertEqual(result.totalCreditsAfterPhaseout, 5000);
});

test('Phaseout rounds up partial thousands', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 201500, // $1,500 over = 2 * $50 (rounds up)
    federalTaxBeforeCredits: 30000,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyPhaseout: true
  });
  assertEqual(result.phaseoutAmount, 100); // 2 * $50
});

// =============================================================================
// Test E: Integration with combined calculation
// =============================================================================

console.log('\nTest E: Integration with calcCombinedFromDomain');

test('Combined calculation includes credits', () => {
  const result = TaxEngine.calcCombinedFromDomain({
    taxYear: 2025,
    filingStatus: 'single',
    domain: {
      redemptionsReceived: 50000,
      redemptionsPending: 0,
      purchasesTotal: 10000,
      includePending: false,
      treatment: 'sweepstakes'
    },
    capitalLossUsed: 0,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyCreditsPhaseout: false
  });

  // Should have federalCredits in result
  if (!result.federalCredits) {
    throw new Error('federalCredits missing from result');
  }
  assertEqual(result.federalCredits.childTaxCreditFull, 2000);
});

test('Combined calculation reduces total tax liability', () => {
  // Without credits
  const resultNoCreds = TaxEngine.calcCombinedFromDomain({
    taxYear: 2025,
    filingStatus: 'single',
    domain: {
      redemptionsReceived: 50000,
      redemptionsPending: 0,
      purchasesTotal: 10000,
      includePending: false,
      treatment: 'sweepstakes'
    },
    capitalLossUsed: 0
  });

  // With 1 child
  const resultWithCreds = TaxEngine.calcCombinedFromDomain({
    taxYear: 2025,
    filingStatus: 'single',
    domain: {
      redemptionsReceived: 50000,
      redemptionsPending: 0,
      purchasesTotal: 10000,
      includePending: false,
      treatment: 'sweepstakes'
    },
    capitalLossUsed: 0,
    dependents: { dependents: 1, childrenUnder17: 1 },
    applyCreditsPhaseout: false
  });

  // With credits should be lower
  const difference = resultNoCreds.totalTaxLiability - resultWithCreds.totalTaxLiability;
  assertClose(difference, 2000, 1, 'Credits should reduce total by ~$2,000');
});

test('No federalCredits when dependents = 0', () => {
  const result = TaxEngine.calcCombinedFromDomain({
    taxYear: 2025,
    filingStatus: 'single',
    domain: {
      redemptionsReceived: 50000,
      redemptionsPending: 0,
      purchasesTotal: 10000,
      includePending: false,
      treatment: 'sweepstakes'
    },
    capitalLossUsed: 0,
    dependents: { dependents: 0, childrenUnder17: 0 }
  });

  if (result.federalCredits) {
    throw new Error('federalCredits should not be present when dependents = 0');
  }
});

// =============================================================================
// Test F: Edge cases
// =============================================================================

console.log('\nTest F: Edge cases');

test('childrenUnder17 clamped to dependents', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 1, childrenUnder17: 5 }, // 5 > 1, should clamp
    applyPhaseout: false
  });
  // Should be clamped to 1 child, 0 other
  assertEqual(result.childTaxCreditFull, 2000);
  assertEqual(result.otherDependentCreditFull, 0);
});

test('Zero dependents = zero credits', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 0, childrenUnder17: 0 },
    applyPhaseout: false
  });
  assertEqual(result.totalCreditsFull, 0);
  assertEqual(result.nonrefundableCreditsApplied, 0);
});

test('Negative inputs treated as zero', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: -2, childrenUnder17: -1 },
    applyPhaseout: false
  });
  assertEqual(result.totalCreditsFull, 0);
});

test('All other dependents (no children under 17)', () => {
  const result = credits.calcFederalCredits({
    filingStatus: 'single',
    agi: 50000,
    federalTaxBeforeCredits: 5000,
    dependents: { dependents: 3, childrenUnder17: 0 },
    applyPhaseout: false
  });
  assertEqual(result.childTaxCreditFull, 0);
  assertEqual(result.otherDependentCreditFull, 1500); // 3 * $500
  assertEqual(result.totalCreditsFull, 1500);
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
console.log('All tests passed!');
