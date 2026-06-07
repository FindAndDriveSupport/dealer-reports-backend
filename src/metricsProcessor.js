/**
 * metricsProcessor.js
 *
 * Seriti E-fficient — core analytics engine.
 * No changes needed for Cloudflare Workers — pure JS, no Node APIs used.
 */

// ─── Income Group Boundaries (ZAR net monthly income) ────────────────────────
const INCOME_GROUPS = [
  { label: 'Lowest',              min: 0,      max: 5000      },
  { label: 'Second Lowest',       min: 5000,   max: 11000     },
  { label: 'Low Emerging Middle', min: 11000,  max: 18000     },
  { label: 'Emerging Middle',     min: 18000,  max: 25000     },
  { label: 'Realised Middle',     min: 25000,  max: 40000     },
  { label: 'Emerging Affluent',   min: 40000,  max: 80000     },
  { label: 'Affluent',            min: 80000,  max: Infinity  },
];

function getIncomeGroup(netIncome) {
  const income = Number(netIncome) || 0;
  return INCOME_GROUPS.find(g => income >= g.min && income < g.max)?.label || 'Lowest';
}

function trimmedMean(values, trimPct = 0.1) {
  const sorted = [...values].filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const trimCount = Math.floor(sorted.length * trimPct);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  if (trimmed.length === 0) return 0;
  return trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
}

function safeAvg(values) {
  const valid = values.filter(v => v != null && !isNaN(v) && v > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function deduplicateLeads(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = [
      (row.FirstName    || '').trim().toLowerCase(),
      (row.LastName     || '').trim().toLowerCase(),
      (row.MobileNumber || '').trim(),
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function calculateFunnel(rows) {
  const unique = deduplicateLeads(rows);
  const total  = unique.length;

  const preQualifications = unique.filter(r =>
    r.ChancesOfApproval && r.ChancesOfApproval !== 'NULL'
  ).length;

  const preApprovals = unique.filter(r =>
    r.IdNumber && String(r.IdNumber).trim() !== '' && r.IdNumber !== 'NULL'
  ).length;

  const applicationsSubmitted = unique.filter(r =>
    r.SubmittedOn && String(r.SubmittedOn).trim() !== '' && r.SubmittedOn !== 'NULL'
  ).length;

  return {
    totalLeads:               total,
    preQualifications,
    preApprovals,
    applicationsSubmitted,
    leadsToPreApproval:       total        > 0 ? +((preApprovals          / total)        * 100).toFixed(1) : 0,
    preApprovalToApplication: preApprovals > 0 ? +((applicationsSubmitted / preApprovals) * 100).toFixed(1) : 0,
  };
}

function calculateIncomeDistribution(rows) {
  const unique = deduplicateLeads(rows);
  const total  = unique.length;
  return INCOME_GROUPS.map(group => {
    const count = unique.filter(r => getIncomeGroup(r.NetIncome) === group.label).length;
    return {
      label:          group.label,
      count,
      percentOfTotal: total > 0 ? +((count / total) * 100).toFixed(1) : 0,
    };
  });
}

function calculateIncomeGroups(rows) {
  const unique = deduplicateLeads(rows);
  const total  = unique.length;

  return INCOME_GROUPS.map(group => {
    const groupRows = unique.filter(r => getIncomeGroup(r.NetIncome) === group.label);
    const count     = groupRows.length;

    if (count === 0) {
      return {
        label: group.label, users: 0, percentOfTotal: 0,
        avgNetIncome: 0, avgEstimatedApproval: 0,
        approvalRate: 0, avgCreditScore: 0, avgDebtLevel: 0,
      };
    }

    const approved       = groupRows.filter(r =>
      r.ChancesOfApproval && ['High', 'Medium'].includes(r.ChancesOfApproval)
    ).length;
    const validApprovals = groupRows.map(r => Number(r.EstimatedApprovalAmount)).filter(v => v > 0);
    const validScores    = groupRows.map(r => Number(r.CreditScore)).filter(v => v > 0);
    const dtiRatios      = groupRows.map(r => {
      const income   = Number(r.NetIncome);
      const expenses = Number(r.CalculatedTotalExpenses);
      return (income > 0 && expenses > 0 && expenses / income < 2)
        ? (expenses / income) * 100 : null;
    }).filter(v => v !== null);

    return {
      label:                group.label,
      users:                count,
      percentOfTotal:       +((count / total) * 100).toFixed(1),
      avgNetIncome:         Math.round(trimmedMean(groupRows.map(r => Number(r.NetIncome)))),
      avgEstimatedApproval: Math.round(safeAvg(validApprovals)),
      approvalRate:         +((approved / count) * 100).toFixed(1),
      avgCreditScore:       Math.round(safeAvg(validScores)),
      avgDebtLevel:         +safeAvg(dtiRatios).toFixed(1),
    };
  });
}

function getGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function scoreConfidence(pct) {
  if (pct >= 70) return 100;
  if (pct >= 50) return 70;
  if (pct >= 30) return 40;
  return 10;
}

function scoreCreditScore(avg) {
  if (!avg || avg === 0) return 10;
  if (avg >= 700) return 100;
  if (avg >= 650) return 80;
  if (avg >= 600) return 55;
  if (avg >= 550) return 30;
  return 10;
}

function scoreDebtLevel(avgDti) {
  if (!avgDti || avgDti === 0) return 10;
  if (avgDti < 30) return 100;
  if (avgDti < 40) return 75;
  if (avgDti < 50) return 50;
  if (avgDti < 60) return 25;
  return 10;
}

const RECOMMENDATIONS = {
  predictorConfidence: {
    A: 'Your traffic is generating well-validated leads. Maintain current acquisition channels and consider scaling spend on top-performing sources.',
    B: 'Good data coverage with room to improve. Review form completion rates — shorter qualification flows tend to improve predictor confidence. Contact your Seriti Account Exec for guidance.',
    C: 'A significant portion of leads lack bureau validation. Improve landing page quality and form UX to capture more complete applicant data. Contact your Seriti Account Exec for assistance.',
    D: 'Low predictor confidence suggests poor-quality traffic. Review your ad targeting and keyword strategy to attract higher-intent visitors. Contact your Seriti Account Exec for assistance.',
    F: 'Critical — most leads cannot be assessed by the bureau. Prioritise improving traffic quality through SEO optimisation and ad audience refinement. Reach out to your Seriti Account Exec immediately.',
  },
  creditScore: {
    A: 'Strong credit profile across your lead pool. Your targeting is reaching financially healthy consumers — maintain your current audience strategy.',
    B: 'Above-average credit quality. Consider refining ad targeting toward higher-income brackets to further improve approval rates. Contact your Seriti Account Exec for guidance.',
    C: 'Average credit scores are limiting approval rates. Review your audience targeting — shift spend toward income and lifestyle segments that correlate with better creditworthiness. Contact your Seriti Account Exec for assistance.',
    D: 'Below-average credit profile. Your current traffic sources may be attracting consumers outside typical approval bands. A full audience and channel review is recommended. Contact your Seriti Account Exec for assistance.',
    F: 'Very low average credit scores indicate a significant targeting misalignment. Pause underperforming campaigns and work with your Seriti Account Exec to restructure your digital strategy immediately.',
  },
  debtLevel: {
    A: 'Low debt burden across your lead pool — strong indicator of affordability. Your audience targeting is well-aligned to qualifying consumers.',
    B: 'Manageable debt levels with some room to improve. Consider promoting your finance offering to younger or early-career audiences with lower existing debt commitments. Contact your Seriti Account Exec for guidance.',
    C: 'Moderate debt levels are reducing affordability scores. Review whether your creative and messaging is attracting consumers already carrying significant financial commitments. Contact your Seriti Account Exec for assistance.',
    D: 'High average debt burden is limiting approvals. A shift in audience targeting toward lower-debt consumer segments is recommended. Contact your Seriti Account Exec for assistance.',
    F: 'Very high debt levels across your lead pool. Current traffic is unlikely to meet affordability requirements. Immediate campaign review and retargeting strategy recommended. Reach out to your Seriti Account Exec immediately.',
  },
};

function calculateLeadQuality(rows) {
  const unique = deduplicateLeads(rows);
  const total  = unique.length;

  const mediumHighConfidence = unique.filter(r =>
    r.PredictorConfidence &&
    ['MEDIUM', 'HIGH'].includes(String(r.PredictorConfidence).toUpperCase())
  ).length;
  const confidencePct      = total > 0 ? (mediumHighConfidence / total) * 100 : 0;
  const confidenceDimScore = scoreConfidence(confidencePct);
  const confidenceGrade    = getGrade(confidenceDimScore);

  const leadsWithCredit = unique.filter(r => r.CreditScore && Number(r.CreditScore) > 0);
  const avgCreditScore  = Math.round(safeAvg(leadsWithCredit.map(r => Number(r.CreditScore))));
  const creditDimScore  = scoreCreditScore(avgCreditScore);
  const creditGrade     = getGrade(creditDimScore);

  const dtiValues = unique.map(r => {
    const income   = Number(r.NetIncome);
    const expenses = Number(r.CalculatedTotalExpenses);
    return (income > 0 && expenses > 0 && expenses / income < 2)
      ? (expenses / income) * 100 : null;
  }).filter(v => v !== null);
  const avgDti       = dtiValues.length > 0 ? +safeAvg(dtiValues).toFixed(1) : 0;
  const debtDimScore = scoreDebtLevel(avgDti);
  const debtGrade    = getGrade(debtDimScore);

  const compositeScore = Math.round(
    (confidenceDimScore * 0.20) +
    (creditDimScore     * 0.40) +
    (debtDimScore       * 0.40)
  );
  const overallGrade = getGrade(compositeScore);

  return {
    score:      compositeScore,
    grade:      overallGrade,
    totalLeads: total,
    dimensions: {
      predictorConfidence: {
        score: confidenceDimScore, grade: confidenceGrade, weight: 0.20,
        rawValue: +confidencePct.toFixed(1),
        label:    `${confidencePct.toFixed(1)}% medium/high confidence`,
        recommendation: RECOMMENDATIONS.predictorConfidence[confidenceGrade],
      },
      creditScore: {
        score: creditDimScore, grade: creditGrade, weight: 0.40,
        rawValue: avgCreditScore,
        label:    avgCreditScore > 0 ? `Avg credit score ${avgCreditScore}` : 'Insufficient credit data',
        recommendation: RECOMMENDATIONS.creditScore[creditGrade],
      },
      debtLevel: {
        score: debtDimScore, grade: debtGrade, weight: 0.40,
        rawValue: avgDti,
        label:    avgDti > 0 ? `Avg DTI ${avgDti}%` : 'Insufficient debt data',
        recommendation: RECOMMENDATIONS.debtLevel[debtGrade],
      },
    },
    leadsWithCreditData: leadsWithCredit.length,
    leadsWithDebtData:   dtiValues.length,
    mediumHighConfidence,
    confidenceBreakdown: {
      high:          unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'HIGH').length,
      medium:        unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'MEDIUM').length,
      low:           unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'LOW').length,
      notApplicable: unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'NOTAPPLICABLE').length,
    },
  };
}

function calculateIntent(rows) {
  const unique = deduplicateLeads(rows);
  return {
    lowIntent:    unique.length,
    mediumIntent: unique.filter(r => r.IdNumber    && String(r.IdNumber).trim()    !== '' && r.IdNumber    !== 'NULL').length,
    highIntent:   unique.filter(r => r.SubmittedOn && String(r.SubmittedOn).trim() !== '' && r.SubmittedOn !== 'NULL').length,
  };
}

function calculateDealerBreakdown(rows) {
  const dealerMap = {};
  rows.forEach(r => {
    const name = r.DealerName || r.ClientName || 'Unknown';
    if (!dealerMap[name]) dealerMap[name] = [];
    dealerMap[name].push(r);
  });
  return Object.entries(dealerMap).map(([dealer, dealerRows]) => ({
    dealer,
    ...calculateFunnel(dealerRows),
  }));
}

export function processRows(rows, metadata = {}) {
  if (!rows || rows.length === 0) throw new Error('No data rows provided');
  return {
    meta: {
      processedAt: new Date().toISOString(),
      totalRows:   rows.length,
      dateRange:   metadata.dateRange  || null,
      clientName:  metadata.clientName || null,
      dealerName:  metadata.dealerName || null,
      clientSlug:  metadata.clientSlug || null,
      dealerSlug:  metadata.dealerSlug || null,
      source:      metadata.source     || 'seriti-api',
    },
    funnel:             calculateFunnel(rows),
    incomeDistribution: calculateIncomeDistribution(rows),
    incomeGroups:       calculateIncomeGroups(rows),
    leadQuality:        calculateLeadQuality(rows),
    intent:             calculateIntent(rows),
    dealerBreakdown:    calculateDealerBreakdown(rows),
    engagement:         metadata.engagement || null,
  };
}
