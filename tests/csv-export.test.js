/**
 * CSV Export Unit Tests
 * Tests for CSV generation with correct headers, row counts, and rounding.
 */

// Mock data for testing
const mockPurchases = [
  { date: '2025-01-15', casino_name: 'Chumba Casino', usd_spent: 49.99, amount_coins: 5000, payment_method: 'card', note: 'Weekly bonus' },
  { date: '2025-01-20', casino_name: 'LuckyLand Slots', usd_spent: 29.995, amount_coins: 3000, payment_method: 'paypal' },
  { date: '2025-02-01', casino_name: 'Chumba Casino', usd_spent: 19.99, amount_coins: 2000 }
];

const mockRedemptions = [
  { date: '2025-01-25', casino_name: 'Chumba Casino', usd_received: 150.123, amount_coins: 15000, status: 'received', redemption_method: 'bank' },
  { date: '2025-02-10', casino_name: 'LuckyLand Slots', usd_received: 75.50, amount_coins: 7500, status: 'pending', redemption_method: 'paypal' },
  { date: '2025-02-15', casino_name: 'Global Poker', usd_received: 200.00, amount_coins: 20000, status: 'received', redemption_method: 'bank' }
];

// Helper: round to cents
function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

// ============ Ledger CSV Tests ============

function generateLedgerData(purchases, redemptions) {
  const ledger = [];

  purchases.forEach(p => {
    ledger.push({
      date: p.date,
      type: 'purchase',
      site: p.casino_name || '',
      amount_usd: roundToCents(p.usd_spent || 0),
      status: 'completed',
      method: p.payment_method || '',
      tx_id: p.tx_id || '',
      notes: p.note || ''
    });
  });

  redemptions.forEach(r => {
    ledger.push({
      date: r.date,
      type: 'redemption',
      site: r.casino_name || '',
      amount_usd: roundToCents(r.usd_received || 0),
      status: r.status || 'received',
      method: r.redemption_method || '',
      tx_id: r.tx_id || '',
      notes: r.note || ''
    });
  });

  ledger.sort((a, b) => a.date.localeCompare(b.date));
  return ledger;
}

function testLedgerHeaders() {
  const ledger = generateLedgerData(mockPurchases, mockRedemptions);
  const expectedHeaders = ['date', 'type', 'site', 'amount_usd', 'status', 'method', 'tx_id', 'notes'];
  const actualHeaders = Object.keys(ledger[0]);

  const match = expectedHeaders.every(h => actualHeaders.includes(h));
  console.log(match ? '✓' : '✗', 'Ledger CSV has correct headers');
  return match;
}

function testLedgerRowCount() {
  const ledger = generateLedgerData(mockPurchases, mockRedemptions);
  const expectedCount = mockPurchases.length + mockRedemptions.length;
  const match = ledger.length === expectedCount;
  console.log(match ? '✓' : '✗', `Ledger CSV has correct row count (${ledger.length} === ${expectedCount})`);
  return match;
}

function testLedgerRounding() {
  const ledger = generateLedgerData(mockPurchases, mockRedemptions);

  // Find the LuckyLand purchase (29.995 should round to 30.00)
  const luckylandPurchase = ledger.find(l => l.site === 'LuckyLand Slots' && l.type === 'purchase');
  const expectedAmount = 30.00;
  const match = luckylandPurchase && luckylandPurchase.amount_usd === expectedAmount;
  console.log(match ? '✓' : '✗', `Ledger CSV rounds to cents (29.995 → ${luckylandPurchase?.amount_usd})`);
  return match;
}

function testLedgerRedemptionRounding() {
  const ledger = generateLedgerData(mockPurchases, mockRedemptions);

  // Find Chumba redemption (150.123 should round to 150.12)
  const chumbaRedemption = ledger.find(l => l.site === 'Chumba Casino' && l.type === 'redemption');
  const expectedAmount = 150.12;
  const match = chumbaRedemption && chumbaRedemption.amount_usd === expectedAmount;
  console.log(match ? '✓' : '✗', `Ledger CSV rounds redemptions to cents (150.123 → ${chumbaRedemption?.amount_usd})`);
  return match;
}

function testLedgerSortOrder() {
  const ledger = generateLedgerData(mockPurchases, mockRedemptions);
  let sorted = true;
  for (let i = 1; i < ledger.length; i++) {
    if (ledger[i].date < ledger[i - 1].date) {
      sorted = false;
      break;
    }
  }
  console.log(sorted ? '✓' : '✗', 'Ledger CSV is sorted by date');
  return sorted;
}

// ============ By-Site Totals Tests ============

function generateBySiteData(purchases, redemptions) {
  const siteMap = {};

  redemptions.forEach(r => {
    const site = r.casino_name || 'Unknown';
    if (!siteMap[site]) {
      siteMap[site] = { redemptions_received: 0, redemptions_pending: 0, purchases: 0 };
    }
    if (r.status === 'pending') {
      siteMap[site].redemptions_pending += r.usd_received || 0;
    } else {
      siteMap[site].redemptions_received += r.usd_received || 0;
    }
  });

  purchases.forEach(p => {
    const site = p.casino_name || 'Unknown';
    if (!siteMap[site]) {
      siteMap[site] = { redemptions_received: 0, redemptions_pending: 0, purchases: 0 };
    }
    siteMap[site].purchases += p.usd_spent || 0;
  });

  return Object.keys(siteMap).sort().map(site => ({
    site,
    redemptions_received_usd: roundToCents(siteMap[site].redemptions_received),
    redemptions_pending_usd: roundToCents(siteMap[site].redemptions_pending),
    purchases_usd: roundToCents(siteMap[site].purchases),
    net_received_minus_purchases: roundToCents(siteMap[site].redemptions_received - siteMap[site].purchases)
  }));
}

function testBySiteHeaders() {
  const data = generateBySiteData(mockPurchases, mockRedemptions);
  const expectedHeaders = ['site', 'redemptions_received_usd', 'redemptions_pending_usd', 'purchases_usd', 'net_received_minus_purchases'];
  const actualHeaders = Object.keys(data[0]);

  const match = expectedHeaders.every(h => actualHeaders.includes(h));
  console.log(match ? '✓' : '✗', 'By-Site CSV has correct headers');
  return match;
}

function testBySiteRowCount() {
  const data = generateBySiteData(mockPurchases, mockRedemptions);
  // Sites: Chumba Casino, LuckyLand Slots, Global Poker
  const expectedCount = 3;
  const match = data.length === expectedCount;
  console.log(match ? '✓' : '✗', `By-Site CSV has correct row count (${data.length} === ${expectedCount})`);
  return match;
}

function testBySiteChumbaTotal() {
  const data = generateBySiteData(mockPurchases, mockRedemptions);
  const chumba = data.find(d => d.site === 'Chumba Casino');

  // Chumba: purchases 49.99 + 19.99 = 69.98, redemptions_received 150.12
  const expectedPurchases = roundToCents(49.99 + 19.99);
  const expectedReceived = 150.12; // rounded from 150.123
  const expectedNet = roundToCents(expectedReceived - expectedPurchases);

  const purchasesMatch = chumba && chumba.purchases_usd === expectedPurchases;
  const receivedMatch = chumba && chumba.redemptions_received_usd === expectedReceived;
  const netMatch = chumba && chumba.net_received_minus_purchases === expectedNet;

  console.log(purchasesMatch ? '✓' : '✗', `Chumba purchases total correct (${chumba?.purchases_usd} === ${expectedPurchases})`);
  console.log(receivedMatch ? '✓' : '✗', `Chumba redemptions received correct (${chumba?.redemptions_received_usd} === ${expectedReceived})`);
  console.log(netMatch ? '✓' : '✗', `Chumba net correct (${chumba?.net_received_minus_purchases} === ${expectedNet})`);

  return purchasesMatch && receivedMatch && netMatch;
}

function testBySitePendingTracked() {
  const data = generateBySiteData(mockPurchases, mockRedemptions);
  const luckyland = data.find(d => d.site === 'LuckyLand Slots');

  // LuckyLand has pending redemption of 75.50
  const match = luckyland && luckyland.redemptions_pending_usd === 75.50;
  console.log(match ? '✓' : '✗', `LuckyLand pending tracked correctly (${luckyland?.redemptions_pending_usd} === 75.50)`);
  return match;
}

// ============ Tax Inputs Summary Tests ============

function generateTaxInputsData(purchases, redemptions, options = {}) {
  const { filing_status = 'single', treatment = 'sweepstakes', include_pending = false } = options;

  let redemptionsReceived = 0;
  let redemptionsPending = 0;

  redemptions.forEach(r => {
    if (r.status === 'pending') {
      redemptionsPending += r.usd_received || 0;
    } else {
      redemptionsReceived += r.usd_received || 0;
    }
  });

  const purchasesTotal = purchases.reduce((sum, p) => sum + (p.usd_spent || 0), 0);
  const grossIncome = roundToCents(redemptionsReceived + (include_pending ? redemptionsPending : 0));

  const disclaimerRow = {
    informational_only: 'TRUE - This is an informational summary only. Not a tax form.',
    filing_status: '',
    treatment: '',
    include_pending: '',
    gross_income: '',
    purchases_total: '',
    redemptions_received: '',
    redemptions_pending: ''
  };

  const dataRow = {
    informational_only: 'true',
    filing_status,
    treatment,
    include_pending: include_pending ? 'yes' : 'no',
    gross_income: roundToCents(grossIncome),
    purchases_total: roundToCents(purchasesTotal),
    redemptions_received: roundToCents(redemptionsReceived),
    redemptions_pending: roundToCents(redemptionsPending)
  };

  return [disclaimerRow, dataRow];
}

function testTaxInputsHasDisclaimer() {
  const data = generateTaxInputsData(mockPurchases, mockRedemptions);
  const hasDisclaimer = data[0].informational_only.includes('informational summary only');
  console.log(hasDisclaimer ? '✓' : '✗', 'Tax Inputs CSV has disclaimer row');
  return hasDisclaimer;
}

function testTaxInputsHeaders() {
  const data = generateTaxInputsData(mockPurchases, mockRedemptions);
  const expectedHeaders = ['informational_only', 'filing_status', 'treatment', 'include_pending', 'gross_income', 'purchases_total', 'redemptions_received', 'redemptions_pending'];
  const actualHeaders = Object.keys(data[0]);

  const match = expectedHeaders.every(h => actualHeaders.includes(h));
  console.log(match ? '✓' : '✗', 'Tax Inputs CSV has correct headers');
  return match;
}

function testTaxInputsGrossIncome() {
  const data = generateTaxInputsData(mockPurchases, mockRedemptions);
  // Received: 150.123 + 200.00 = 350.123 → 350.12 (rounded)
  const expectedGross = roundToCents(150.123 + 200.00);
  const match = data[1].gross_income === expectedGross;
  console.log(match ? '✓' : '✗', `Tax Inputs gross income correct (${data[1].gross_income} === ${expectedGross})`);
  return match;
}

function testTaxInputsWithPending() {
  const data = generateTaxInputsData(mockPurchases, mockRedemptions, { include_pending: true });
  // Received: 150.123 + 200.00 = 350.123, Pending: 75.50, Total: 425.623 → 425.62
  const expectedGross = roundToCents(150.123 + 200.00 + 75.50);
  const match = data[1].gross_income === expectedGross;
  console.log(match ? '✓' : '✗', `Tax Inputs with pending gross income correct (${data[1].gross_income} === ${expectedGross})`);
  return match;
}

function testTaxInputsPurchasesTotal() {
  const data = generateTaxInputsData(mockPurchases, mockRedemptions);
  // Purchases: 49.99 + 29.995 + 19.99 = 99.975 → 99.98
  const expectedPurchases = roundToCents(49.99 + 29.995 + 19.99);
  const match = data[1].purchases_total === expectedPurchases;
  console.log(match ? '✓' : '✗', `Tax Inputs purchases total correct (${data[1].purchases_total} === ${expectedPurchases})`);
  return match;
}

function testTaxInputsRounding() {
  const data = generateTaxInputsData(mockPurchases, mockRedemptions);

  // Check all numeric values are rounded to 2 decimal places
  const gross = data[1].gross_income;
  const purchases = data[1].purchases_total;
  const received = data[1].redemptions_received;
  const pending = data[1].redemptions_pending;

  const allRounded = [gross, purchases, received, pending].every(val => {
    const str = val.toString();
    const parts = str.split('.');
    return parts.length === 1 || parts[1].length <= 2;
  });

  console.log(allRounded ? '✓' : '✗', 'Tax Inputs all values rounded to cents');
  return allRounded;
}

// ============ Run All Tests ============

function runTests() {
  console.log('\n========================================');
  console.log('CSV Export Unit Tests');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  // Ledger Tests
  console.log('Ledger CSV');
  [
    testLedgerHeaders,
    testLedgerRowCount,
    testLedgerRounding,
    testLedgerRedemptionRounding,
    testLedgerSortOrder
  ].forEach(test => {
    if (test()) passed++; else failed++;
  });

  // By-Site Tests
  console.log('\nBy-Site Totals CSV');
  [
    testBySiteHeaders,
    testBySiteRowCount,
    testBySiteChumbaTotal,
    testBySitePendingTracked
  ].forEach(test => {
    if (test()) passed++; else failed++;
  });

  // Tax Inputs Tests
  console.log('\nTax Inputs Summary CSV');
  [
    testTaxInputsHasDisclaimer,
    testTaxInputsHeaders,
    testTaxInputsGrossIncome,
    testTaxInputsWithPending,
    testTaxInputsPurchasesTotal,
    testTaxInputsRounding
  ].forEach(test => {
    if (test()) passed++; else failed++;
  });

  console.log('\n========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  console.log('All tests passed!');
}

runTests();
