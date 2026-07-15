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

function calculateFunnel(rows, applicationsOverride = null) {
  const unique = deduplicateLeads(rows);
  const total  = unique.length;

  // Step 1 of the widget IS the pre-qualification (Seriti's affordability
  // check runs immediately on entry) — every lead is a pre-qual by
  // definition, not a filtered subset of leads with a ChancesOfApproval value.
  const preQualifications = total;

  const preApprovals = unique.filter(r =>
    r.IdNumber && String(r.IdNumber).trim() !== '' && r.IdNumber !== 'NULL'
  ).length;

  // policy_events (D1) is the authoritative record of applications actually
  // created in Edith — overrides Seriti's own SubmittedOn flag when provided.
  const applicationsSubmitted = applicationsOverride != null
    ? applicationsOverride
    : unique.filter(r =>
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

// ─── Scoring functions ────────────────────────────────────────────────────────

function getGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

// Traffic quality dimensions
function scoreConfidence(pct) {
  if (pct >= 70) return 100;
  if (pct >= 50) return 70;
  if (pct >= 30) return 40;
  return 10;
}

function scoreApplicationCompletion(pct) {
  if (pct >= 60) return 100;
  if (pct >= 40) return 75;
  if (pct >= 20) return 45;
  return 15;
}

// Applicant quality dimensions
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

function scoreIncomeProfile(avgIncome) {
  if (!avgIncome || avgIncome === 0) return 10;
  if (avgIncome >= 40000) return 100;
  if (avgIncome >= 25000) return 80;
  if (avgIncome >= 18000) return 55;
  if (avgIncome >= 11000) return 30;
  return 10;
}

// ─── Next threshold simulation (for estimated score gain) ────────────────────

function nextThreshold(scoreFn, currentValue, steps) {
  for (const threshold of steps) {
    if (currentValue < threshold) {
      return { value: threshold, score: scoreFn(threshold) };
    }
  }
  return null;
}

const CONFIDENCE_THRESHOLDS    = [30, 50, 70];
const COMPLETION_THRESHOLDS    = [20, 40, 60];
const CREDIT_THRESHOLDS        = [550, 600, 650, 700];
const DTI_THRESHOLDS           = [60, 50, 40, 30]; // descending — lower is better
const INCOME_THRESHOLDS        = [11000, 18000, 25000, 40000];

function simulateGain(currentComposite, currentDimScore, weight, nextDimScore) {
  const gain = (nextDimScore - currentDimScore) * weight;
  return Math.round(gain);
}

// ─── Insight engine ───────────────────────────────────────────────────────────

/**
 * Generates ranked, threshold-based marketing insights.
 * All recommendations are framed from the dealer/marketer perspective —
 * audience targeting, campaign spend, channel mix.
 */
function generateInsights({
  confidencePct,
  completionPct,
  avgCreditScore,
  avgDti,
  avgIncome,
  trafficScore,
  applicantScore,
  overallScore,
  trafficWeights,
  applicantWeights,
}) {
  const insights = [];

  // ── Traffic: bureau confidence ────────────────────────────────────────────
  const confScore = scoreConfidence(confidencePct);
  const confNext  = nextThreshold(scoreConfidence, confidencePct, CONFIDENCE_THRESHOLDS);
  if (confNext) {
    const gain = simulateGain(overallScore, confScore, trafficWeights.confidence, confNext.score);
    insights.push({
      severity:        gain >= 10 ? 'high' : gain >= 5 ? 'medium' : 'low',
      category:        'Traffic quality',
      dimension:       'bureauConfidence',
      title:           'Low bureau verification rate',
      finding:         `Only ${confidencePct.toFixed(1)}% of your leads could be credit-assessed by the bureau.`,
      impact:          'Leads that can\'t be assessed can\'t be pre-approved, reducing your overall conversion rate.',
      recommendation:  'This typically indicates low-intent traffic. Review your highest-volume campaigns and consider pausing those with high click-through but low completion rates. Shifting budget toward intent-based keywords and targeted demographic audiences tends to improve verification rates.',
      currentValue:    +confidencePct.toFixed(1),
      targetValue:     confNext.value,
      currentLabel:    `${confidencePct.toFixed(1)}% verified`,
      targetLabel:     `${confNext.value}% verified`,
      estimatedGain:   gain,
      estimatedScore:  overallScore + gain,
    });
  }

  // ── Traffic: application completion ──────────────────────────────────────
  const compScore = scoreApplicationCompletion(completionPct);
  const compNext  = nextThreshold(scoreApplicationCompletion, completionPct, COMPLETION_THRESHOLDS);
  if (compNext) {
    const gain = simulateGain(overallScore, compScore, trafficWeights.completion, compNext.score);
    insights.push({
      severity:        gain >= 10 ? 'high' : gain >= 5 ? 'medium' : 'low',
      category:        'Traffic quality',
      dimension:       'applicationCompletion',
      title:           'Low application completion rate',
      finding:         `Only ${completionPct.toFixed(1)}% of leads completed a full application.`,
      impact:          'Incomplete applications can\'t be submitted for finance, directly limiting funded deals.',
      recommendation:  'Consider whether your ads are setting accurate expectations about the application process. Traffic from broad awareness campaigns tends to have lower intent and higher drop-off. Retargeting warm audiences or focusing on bottom-of-funnel keywords typically improves completion rates.',
      currentValue:    +completionPct.toFixed(1),
      targetValue:     compNext.value,
      currentLabel:    `${completionPct.toFixed(1)}% completed`,
      targetLabel:     `${compNext.value}% completed`,
      estimatedGain:   gain,
      estimatedScore:  overallScore + gain,
    });
  }

  // ── Applicant: credit score ───────────────────────────────────────────────
  if (avgCreditScore > 0) {
    const credScore = scoreCreditScore(avgCreditScore);
    const credNext  = nextThreshold(scoreCreditScore, avgCreditScore, CREDIT_THRESHOLDS);
    if (credNext) {
      const gain = simulateGain(overallScore, credScore, applicantWeights.credit, credNext.score);
      insights.push({
        severity:        gain >= 10 ? 'high' : gain >= 5 ? 'medium' : 'low',
        category:        'Applicant quality',
        dimension:       'creditScore',
        title:           'Below-average credit profile',
        finding:         `Average credit score across your leads is ${Math.round(avgCreditScore)}.`,
        impact:          'Lower credit scores reduce approval probability, meaning fewer funded deals from the same lead volume.',
        recommendation:  `Your current audiences may include consumers who fall outside typical approval ranges. Consider shifting ad spend toward employed, higher-income demographics. Reviewing which campaigns produce the lowest credit scores and reallocating that budget to better-performing sources is likely to improve this metric.`,
        currentValue:    Math.round(avgCreditScore),
        targetValue:     credNext.value,
        currentLabel:    `Avg ${Math.round(avgCreditScore)}`,
        targetLabel:     `Target ${credNext.value}+`,
        estimatedGain:   gain,
        estimatedScore:  overallScore + gain,
      });
    }
  }

  // ── Applicant: DTI ────────────────────────────────────────────────────────
  if (avgDti > 0) {
    const dtiScore = scoreDebtLevel(avgDti);
    // DTI is inverse — lower is better, so thresholds go downward
    const dtiNext = DTI_THRESHOLDS.find(t => avgDti > t)
      ? { value: DTI_THRESHOLDS.find(t => avgDti > t), score: scoreDebtLevel(DTI_THRESHOLDS.find(t => avgDti > t)) }
      : null;
    if (dtiNext) {
      const gain = simulateGain(overallScore, dtiScore, applicantWeights.debt, dtiNext.score);
      insights.push({
        severity:        gain >= 10 ? 'high' : gain >= 5 ? 'medium' : 'low',
        category:        'Applicant quality',
        dimension:       'debtLevel',
        title:           'High existing debt burden',
        finding:         `Average debt-to-income ratio across your leads is ${avgDti.toFixed(1)}%.`,
        impact:          'High existing commitments reduce affordability, limiting the loan amounts that can be approved.',
        recommendation:  'Your audiences may be skewing toward consumers already carrying significant financial obligations. Reviewing audience demographics — particularly age groups, employment type, and income bands — and adjusting targeting toward lower-debt segments can improve this metric over time.',
        currentValue:    +avgDti.toFixed(1),
        targetValue:     dtiNext.value,
        currentLabel:    `Avg DTI ${avgDti.toFixed(1)}%`,
        targetLabel:     `Target DTI <${dtiNext.value}%`,
        estimatedGain:   gain,
        estimatedScore:  overallScore + gain,
      });
    }
  }

  // ── Applicant: income profile ─────────────────────────────────────────────
  if (avgIncome > 0) {
    const incScore = scoreIncomeProfile(avgIncome);
    const incNext  = nextThreshold(scoreIncomeProfile, avgIncome, INCOME_THRESHOLDS);
    if (incNext) {
      const gain = simulateGain(overallScore, incScore, applicantWeights.income, incNext.score);
      insights.push({
        severity:        gain >= 5 ? 'medium' : 'low',
        category:        'Applicant quality',
        dimension:       'incomeProfile',
        title:           'Lower-income audience profile',
        finding:         `Average net income across your leads is R${Math.round(avgIncome).toLocaleString('en-ZA')}/month.`,
        impact:          'Lower income levels reduce estimated approval amounts, limiting deals to lower-value vehicles.',
        recommendation:  'Consider whether your creative and messaging is resonating with employed, middle-income consumers. Platforms like LinkedIn and targeted Google Display audiences with household income filters can help shift the income profile of incoming leads.',
        currentValue:    Math.round(avgIncome),
        targetValue:     incNext.value,
        currentLabel:    `Avg R${Math.round(avgIncome / 1000)}k/mo`,
        targetLabel:     `Target R${Math.round(incNext.value / 1000)}k+/mo`,
        estimatedGain:   gain,
        estimatedScore:  overallScore + gain,
      });
    }
  }

  // ── Positive findings (dimensions already performing well) ────────────────
  if (confidencePct >= 70) {
    insights.push({
      severity:        'positive',
      category:        'Traffic quality',
      dimension:       'bureauConfidence',
      title:           'Strong bureau verification rate',
      finding:         `${confidencePct.toFixed(1)}% of your leads are bureau-verifiable — well above average.`,
      impact:          'High verification rates mean more leads can be assessed and pre-approved.',
      recommendation:  'Your traffic is generating high-intent, assessable leads. Identify which campaigns are driving this quality and consider scaling spend on those sources.',
      currentValue:    +confidencePct.toFixed(1),
      targetValue:     null,
      currentLabel:    `${confidencePct.toFixed(1)}% verified`,
      targetLabel:     null,
      estimatedGain:   0,
      estimatedScore:  overallScore,
    });
  }

  if (avgCreditScore >= 650) {
    insights.push({
      severity:        'positive',
      category:        'Applicant quality',
      dimension:       'creditScore',
      title:           'Strong credit profile',
      finding:         `Average credit score of ${Math.round(avgCreditScore)} indicates a well-qualified audience.`,
      impact:          'Higher credit scores directly improve approval rates and funded deal volume.',
      recommendation:  'Your targeting is reaching financially healthy consumers. Maintain your current audience strategy and look for ways to scale the channels producing this quality.',
      currentValue:    Math.round(avgCreditScore),
      targetValue:     null,
      currentLabel:    `Avg ${Math.round(avgCreditScore)}`,
      targetLabel:     null,
      estimatedGain:   0,
      estimatedScore:  overallScore,
    });
  }

  // Sort: high severity first, then by estimated gain descending
  const severityOrder = { high: 0, medium: 1, low: 2, positive: 3 };
  insights.sort((a, b) => {
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.estimatedGain - a.estimatedGain;
  });

  return insights;
}

// ─── Traffic quality ──────────────────────────────────────────────────────────

function calculateTrafficQuality(rows, applicationsOverride = null) {
  const unique = deduplicateLeads(rows);
  const total  = unique.length;

  // Bureau confidence
  const mediumHighConfidence = unique.filter(r =>
    r.PredictorConfidence &&
    ['MEDIUM', 'HIGH'].includes(String(r.PredictorConfidence).toUpperCase())
  ).length;
  const confidencePct   = total > 0 ? (mediumHighConfidence / total) * 100 : 0;
  const confidenceScore = scoreConfidence(confidencePct);

  // Application completion — policy_events (D1) overrides Seriti's
  // SubmittedOn flag when provided, same source as funnel.applicationsSubmitted.
  const completed       = applicationsOverride != null
    ? applicationsOverride
    : unique.filter(r =>
        r.SubmittedOn && String(r.SubmittedOn).trim() !== '' && r.SubmittedOn !== 'NULL'
      ).length;
  const completionPct   = total > 0 ? (completed / total) * 100 : 0;
  const completionScore = scoreApplicationCompletion(completionPct);

  const weights = { confidence: 0.60, completion: 0.40 };
  const compositeScore = Math.round(
    (confidenceScore * weights.confidence) +
    (completionScore * weights.completion)
  );

  return {
    score:          compositeScore,
    grade:          getGrade(compositeScore),
    confidencePct:  +confidencePct.toFixed(1),
    completionPct:  +completionPct.toFixed(1),
    confidenceScore,
    completionScore,
    weights,
    mediumHighConfidence,
    completedApplications: completed,
    totalLeads: total,
    confidenceBreakdown: {
      high:          unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'HIGH').length,
      medium:        unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'MEDIUM').length,
      low:           unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'LOW').length,
      notApplicable: unique.filter(r => String(r.PredictorConfidence).toUpperCase() === 'NOTAPPLICABLE').length,
    },
  };
}

// ─── Applicant quality ────────────────────────────────────────────────────────

function calculateApplicantQuality(rows) {
  const unique = deduplicateLeads(rows);

  // Credit score
  const leadsWithCredit = unique.filter(r => r.CreditScore && Number(r.CreditScore) > 0);
  const avgCreditScore  = Math.round(safeAvg(leadsWithCredit.map(r => Number(r.CreditScore))));
  const creditScore     = scoreCreditScore(avgCreditScore);

  // DTI
  const dtiValues = unique.map(r => {
    const income   = Number(r.NetIncome);
    const expenses = Number(r.CalculatedTotalExpenses);
    return (income > 0 && expenses > 0 && expenses / income < 2)
      ? (expenses / income) * 100 : null;
  }).filter(v => v !== null);
  const avgDti   = dtiValues.length > 0 ? +safeAvg(dtiValues).toFixed(1) : 0;
  const dtiScore = scoreDebtLevel(avgDti);

  // Income
  const incomeValues = unique.map(r => Number(r.NetIncome)).filter(v => v > 0);
  const avgIncome    = Math.round(safeAvg(incomeValues));
  const incomeScore  = scoreIncomeProfile(avgIncome);

  const weights = { credit: 0.45, debt: 0.35, income: 0.20 };
  const compositeScore = Math.round(
    (creditScore  * weights.credit) +
    (dtiScore     * weights.debt)   +
    (incomeScore  * weights.income)
  );

  return {
    score:          compositeScore,
    grade:          getGrade(compositeScore),
    avgCreditScore,
    avgDti,
    avgIncome,
    creditScore,
    dtiScore,
    incomeScore,
    weights,
    leadsWithCreditData: leadsWithCredit.length,
    leadsWithDebtData:   dtiValues.length,
  };
}

// ─── Overall lead quality intelligence ───────────────────────────────────────

function calculateLeadQualityIntelligence(rows, applicationsOverride = null) {
  const traffic   = calculateTrafficQuality(rows, applicationsOverride);
  const applicant = calculateApplicantQuality(rows);

  const overallWeights = { traffic: 0.40, applicant: 0.60 };
  const overallScore   = Math.round(
    (traffic.score   * overallWeights.traffic) +
    (applicant.score * overallWeights.applicant)
  );
  const overallGrade = getGrade(overallScore);

  const insights = generateInsights({
    confidencePct:   traffic.confidencePct,
    completionPct:   traffic.completionPct,
    avgCreditScore:  applicant.avgCreditScore,
    avgDti:          applicant.avgDti,
    avgIncome:       applicant.avgIncome,
    trafficScore:    traffic.score,
    applicantScore:  applicant.score,
    overallScore,
    trafficWeights:  traffic.weights,
    applicantWeights: applicant.weights,
  });

  // Biggest opportunity = highest-gain non-positive insight
  const biggestOpportunity = insights.find(i => i.severity !== 'positive' && i.estimatedGain > 0) || null;

  return {
    score:              overallScore,
    grade:              overallGrade,
    totalLeads:         traffic.totalLeads,
    trafficQuality:     traffic,
    applicantQuality:   applicant,
    overallWeights,
    insights,
    biggestOpportunity,
  };
}

// ─── Legacy: kept for dataQuality field backward compatibility ────────────────

function calculateLeadQuality(rows, applicationsOverride = null) {
  const lqi = calculateLeadQualityIntelligence(rows, applicationsOverride);
  return {
    score:               lqi.score,
    grade:               lqi.grade,
    totalLeads:          lqi.totalLeads,
    dimensions: {
      predictorConfidence: {
        score:          lqi.trafficQuality.confidenceScore,
        grade:          getGrade(lqi.trafficQuality.confidenceScore),
        weight:         0.20,
        rawValue:       lqi.trafficQuality.confidencePct,
        label:          `${lqi.trafficQuality.confidencePct}% medium/high confidence`,
      },
      creditScore: {
        score:          lqi.applicantQuality.creditScore,
        grade:          getGrade(lqi.applicantQuality.creditScore),
        weight:         0.40,
        rawValue:       lqi.applicantQuality.avgCreditScore,
        label:          lqi.applicantQuality.avgCreditScore > 0
                          ? `Avg credit score ${lqi.applicantQuality.avgCreditScore}`
                          : 'Insufficient credit data',
      },
      debtLevel: {
        score:          lqi.applicantQuality.dtiScore,
        grade:          getGrade(lqi.applicantQuality.dtiScore),
        weight:         0.40,
        rawValue:       lqi.applicantQuality.avgDti,
        label:          lqi.applicantQuality.avgDti > 0
                          ? `Avg DTI ${lqi.applicantQuality.avgDti}%`
                          : 'Insufficient debt data',
      },
    },
    leadsWithCreditData:   lqi.applicantQuality.leadsWithCreditData,
    leadsWithDebtData:     lqi.applicantQuality.leadsWithDebtData,
    mediumHighConfidence:  lqi.trafficQuality.mediumHighConfidence,
    confidenceBreakdown:   lqi.trafficQuality.confidenceBreakdown,
  };
}

function calculateIntent(rows, applicationsOverride = null) {
  const unique = deduplicateLeads(rows);
  return {
    lowIntent:    unique.length,
    mediumIntent: unique.filter(r => r.IdNumber    && String(r.IdNumber).trim()    !== '' && r.IdNumber    !== 'NULL').length,
    // High Intent means "an actual application was submitted" — same
    // policy_events-backed source as funnel.applicationsSubmitted when provided.
    highIntent:   applicationsOverride != null
      ? applicationsOverride
      : unique.filter(r => r.SubmittedOn && String(r.SubmittedOn).trim() !== '' && r.SubmittedOn !== 'NULL').length,
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

  // Real policy_events (D1) count, resolved by report.js before calling this
  // — the single source of truth for "applications" across Funnel, Intent,
  // and Lead Quality Intelligence. Falls back to Seriti's SubmittedOn flag
  // wherever this isn't supplied (e.g. dealers with no D1 mapping yet).
  const applicationsOverride = metadata.applicationsOverrideCount ?? null;

  const lqi = calculateLeadQualityIntelligence(rows, applicationsOverride);
  const lq  = calculateLeadQuality(rows, applicationsOverride); // backward compat

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
    funnel:                   calculateFunnel(rows, applicationsOverride),
    incomeDistribution:       calculateIncomeDistribution(rows),
    incomeGroups:             calculateIncomeGroups(rows),
    leadQualityIntelligence:  lqi,   // ← new
    leadQuality:              lq,    // ← kept for backward compat
    dataQuality: {                   // ← kept for backward compat
      score:                lq.score,
      totalLeads:           lq.totalLeads,
      mediumHighConfidence: lq.mediumHighConfidence,
      withIdNumber:         lq.leadsWithCreditData,
      withCreditScore:      lq.leadsWithCreditData,
      confidenceBreakdown:  lq.confidenceBreakdown,
    },
    intent:             calculateIntent(rows, applicationsOverride),
    dealerBreakdown:    calculateDealerBreakdown(rows),
    engagement:         metadata.engagement || null,
  };
}
