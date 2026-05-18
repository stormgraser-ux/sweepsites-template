/**
 * Tax Summary CSV Builder
 * Builds a CSV snapshot of the current tax estimate for planning/recordkeeping.
 *
 * IMPORTANT: This is NOT a tax form. NOT for filing. NOT for TurboTax/FreeTaxUSA import.
 */

(function(global) {
  'use strict';

  const APP_VERSION = '1.0.0';

  /**
   * CSV column headers in exact order
   */
  const CSV_HEADERS = [
    // Meta
    'tax_year',
    'generated_at_iso',
    'app_version',
    'informational_only',
    // User selections
    'filing_status',
    'state',
    'treatment',
    'include_pending_redemptions',
    'other_itemized_deductions',
    'capital_loss_used_est',
    'dependents_count',
    'children_under_17_count',
    'apply_oregon_kicker',
    'or40_2024_line24_total_tax_before_credits',
    // Inputs used
    'redemptions_received_usd',
    'redemptions_pending_usd',
    'purchases_total_usd',
    'gross_income_used_usd',
    'agi_used_usd',
    // Deductions
    'federal_deduction_method_used',
    'federal_deduction_used_usd',
    'federal_taxable_income_usd',
    // Federal tax
    'federal_tax_before_credits_usd',
    'federal_credits_usd',
    'federal_tax_after_credits_usd',
    'federal_marginal_bracket_rate',
    'federal_effective_rate',
    // Oregon
    'oregon_taxable_income_usd',
    'oregon_tax_before_credits_usd',
    'oregon_exemption_credit_usd',
    'oregon_kicker_credit_usd',
    'oregon_tax_owed_usd',
    'oregon_refund_credit_usd',
    // Totals
    'total_estimated_tax_liability_usd',
    'notes'
  ];

  /**
   * Round to cents (2 decimal places)
   */
  function roundToCents(value) {
    if (value === null || value === undefined || value === '') return '';
    return Math.round(value * 100) / 100;
  }

  /**
   * Format a number value for CSV (round to cents, empty string for nullish)
   */
  function fmtNum(value) {
    if (value === null || value === undefined || value === '') return '';
    return roundToCents(value).toString();
  }

  /**
   * Format a boolean for CSV
   */
  function fmtBool(value) {
    return value ? 'true' : 'false';
  }

  /**
   * Format a rate (decimal) to percentage string with 2 decimals
   */
  function fmtRate(value) {
    if (value === null || value === undefined || value === '') return '';
    return (value * 100).toFixed(2) + '%';
  }

  /**
   * Escape CSV field (handle commas, quotes, newlines)
   */
  function escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  /**
   * Build a tax summary CSV row from the computed result
   *
   * @param {Object} summary - The summary object containing all tax calculation data
   * @param {Object} summary.selections - User selections
   * @param {Object} summary.inputs - Input values used
   * @param {Object} summary.result - TaxEngine.calcCombinedFromDomain result
   * @returns {Object} Object with { headers: string[], row: string[], csv: string }
   */
  function buildTaxSummaryCsvRow(summary) {
    const { selections, inputs, result } = summary;
    const isOregon = selections.state === 'OR';

    // Build the row values in header order
    const row = [
      // Meta
      selections.taxYear || 2025,
      new Date().toISOString(),
      APP_VERSION,
      'true', // informational_only always true

      // User selections
      selections.filingStatus || 'single',
      selections.state || 'OR',
      selections.treatment || 'sweepstakes',
      fmtBool(selections.includePending),
      fmtNum(selections.otherItemizedDeductions || 0),
      fmtNum(selections.capitalLossUsed || 0),
      (selections.dependents || 0).toString(),
      (selections.childrenUnder17 || 0).toString(),
      fmtBool(selections.applyKicker),
      isOregon ? fmtNum(selections.or40Line24 || 0) : '',

      // Inputs used
      fmtNum(inputs.redemptionsReceived),
      fmtNum(inputs.redemptionsPending),
      fmtNum(inputs.purchasesTotal),
      fmtNum(result.grossIncome),
      fmtNum(result.agi),

      // Deductions
      result.federal.deductionMethod || 'standard',
      fmtNum(result.federal.deductionUsed),
      fmtNum(result.federal.taxableIncome),

      // Federal tax
      fmtNum(result.federal.federalTax),
      fmtNum(result.federalCredits ? result.federalCredits.nonrefundableCreditsApplied : 0),
      fmtNum(result.federalCredits ? result.federalCredits.federalTaxAfterCredits : result.federal.federalTax),
      fmtRate(result.federal.marginalBracket),
      fmtRate(result.federal.effectiveRate),

      // Oregon (empty if not OR)
      isOregon ? fmtNum(result.oregon.taxableIncome) : '',
      isOregon ? fmtNum(result.oregon.taxBeforeCredits) : '',
      isOregon ? fmtNum(result.oregon.exemptionCredit) : '',
      isOregon ? fmtNum(result.oregon.kickerCredit) : '',
      isOregon ? fmtNum(result.oregon.taxOwed) : '',
      isOregon ? fmtNum(result.oregon.refundCredit) : '',

      // Totals
      fmtNum(result.totalTaxLiability),
      'Estimate only. Not a tax form.'
    ];

    // Build CSV string with comment header
    const commentLines = [
      '# Informational estimate only. Not a tax form. Not for filing.',
      '# Generated by Sweepsites Tracker. Verify with official forms and tax software.'
    ];

    const headerLine = CSV_HEADERS.map(escapeCSV).join(',');
    const dataLine = row.map(escapeCSV).join(',');
    const csv = commentLines.join('\n') + '\n' + headerLine + '\n' + dataLine + '\n';

    return {
      headers: CSV_HEADERS,
      row,
      csv
    };
  }

  /**
   * Generate the filename for the tax summary CSV
   * @param {number} taxYear - Tax year
   * @returns {string} Filename
   */
  function getTaxSummaryCsvFilename(taxYear) {
    const today = new Date().toISOString().split('T')[0];
    return `tax_estimate_summary_${taxYear}_${today}.csv`;
  }

  /**
   * Trigger a CSV download in the browser
   * @param {string} csv - CSV content
   * @param {string} filename - Filename
   */
  function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');

    if (navigator.msSaveBlob) {
      // IE 10+
      navigator.msSaveBlob(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }

  // Export
  global.CsvBuilder = {
    buildTaxSummaryCsvRow,
    getTaxSummaryCsvFilename,
    downloadCsv,
    CSV_HEADERS,
    APP_VERSION,
    // For testing
    fmtNum,
    fmtBool,
    fmtRate,
    escapeCSV,
    roundToCents
  };

})(typeof window !== 'undefined' ? window : this);
