/**
 * Click2Kart Interest & Amortization Engine
 * Precision financial service for daily compounding and repayment schedule generation
 */

// Business Timezone
export const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * Returns date in YYYY-MM-DD string according to business timezone
 */
export function getBusinessDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/**
 * Calculates interest for a principal over n days based on the approved product method
 * Distinguishes DAILY_SIMPLE from DAILY_COMPOUNDING.
 * Strictly calculates on principal only; fees and taxes are NEVER compounded.
 *
 * Formula DAILY_SIMPLE: Interest = P * (r / dayCount) * n
 * Formula DAILY_COMPOUNDING: A = P * (1 + r / dayCount)^n, Interest = A - P
 */
export function calculateAccruedInterest({
  principal,
  annualRatePercent,
  days,
  dayCountConvention = "ACTUAL_365",
  interestMethod = "DAILY_COMPOUNDING"
}) {
  const p = Number(principal);
  const rate = Number(annualRatePercent);
  const n = Math.max(0, parseInt(days, 10));

  if (p <= 0 || rate <= 0 || n <= 0) {
    return {
      principal: p,
      interest: 0,
      interestAccrued: 0,
      totalAmount: p,
      totalPayable: p,
      dailyRate: 0,
      days: n,
      method: interestMethod
    };
  }

  const denominator = dayCountConvention === "ACTUAL_360" ? 360 : 365;
  const dailyRate = rate / 100 / denominator;

  let interestPrecise = 0;
  if (interestMethod === "DAILY_SIMPLE" || interestMethod === "REDUCING_BALANCE") {
    // Simple daily accrual: Interest = P * dailyRate * n
    interestPrecise = p * dailyRate * n;
  } else {
    // Daily compounding: A = P * (1 + dailyRate)^n - P
    const totalAmountPrecise = p * Math.pow(1 + dailyRate, n);
    interestPrecise = totalAmountPrecise - p;
  }

  // Exact 2 decimal places currency rounding (nearest paisa)
  const interest = Number(interestPrecise.toFixed(2));
  const totalAmount = Number((p + interest).toFixed(2));

  return {
    principal: p,
    interest,
    interestAccrued: interest,
    totalAmount,
    totalPayable: totalAmount,
    dailyRate,
    days: n,
    method: interestMethod
  };
}

/**
 * Backward-compatible alias for calculateAccruedInterest with DAILY_COMPOUNDING default
 */
export function calculateDailyCompoundedInterest(params) {
  return calculateAccruedInterest({
    ...params,
    interestMethod: params.interestMethod || "DAILY_COMPOUNDING"
  });
}

/**
 * Generates an equal-instalment repayment schedule
 * Enforces tenure strictly between 3 and 5 months
 * Correctly preserves estimatedInstalment (intended instalment amount)
 */
export function generateRepaymentSchedule({
  principal,
  annualRatePercent,
  tenureMonths,
  frequency = "WEEKLY",
  startDate = new Date(),
  dayCountConvention = "ACTUAL_365",
  interestMethod = "DAILY_COMPOUNDING",
  permittedTenures,
  minTenureMonths,
  maxTenureMonths
}, options = {}) {
  const p = Number(principal);
  const rate = Number(annualRatePercent);
  const tenure = parseInt(tenureMonths, 10);

  const effectivePermitted = (options && options.permittedTenures) || permittedTenures;
  const effectiveMin = (options && options.minTenureMonths !== undefined) ? options.minTenureMonths : minTenureMonths;
  const effectiveMax = (options && options.maxTenureMonths !== undefined) ? options.maxTenureMonths : maxTenureMonths;

  const allowedList = effectivePermitted && effectivePermitted.length > 0 ? effectivePermitted : null;
  const minT = effectiveMin !== undefined ? effectiveMin : (allowedList ? Math.min(...allowedList) : 3);
  const maxT = effectiveMax !== undefined ? effectiveMax : (allowedList ? Math.max(...allowedList) : 5);

  if (allowedList ? !allowedList.includes(tenure) : (tenure < minT || tenure > maxT)) {
    throw new Error(`Invalid tenure: ${tenure} months. Approved tenure must be strictly between ${minT} and ${maxT} months.`);
  }

  if (p <= 0) {
    throw new Error("Principal amount must be positive.");
  }

  // Determine number of instalments
  let numInstalments = 0;
  let intervalDays = 7;

  if (frequency === "WEEKLY") {
    intervalDays = 7;
    if (tenure === 1) numInstalments = 4;
    else if (tenure === 2) numInstalments = 9;
    else if (tenure === 3) numInstalments = 13;
    else if (tenure === 4) numInstalments = 17;
    else if (tenure === 5) numInstalments = 22;
    else numInstalments = Math.max(1, Math.round((tenure * 30.4167) / 7));
  } else if (frequency === "DAILY") {
    intervalDays = 1;
    numInstalments = tenure * 30; // 30 days per month
  } else {
    throw new Error(`Unsupported frequency: ${frequency}`);
  }

  // Periodic interest rate for the amortization formula
  const denominator = dayCountConvention === "ACTUAL_360" ? 360 : 365;
  const periodicRate = (rate / 100 / denominator) * intervalDays;

  // Standard amortized instalment formula:
  // EMI = [P * r * (1+r)^n] / [(1+r)^n - 1]
  let intendedInstalment = 0;
  if (periodicRate > 0) {
    const factor = Math.pow(1 + periodicRate, numInstalments);
    intendedInstalment = Number(((p * periodicRate * factor) / (factor - 1)).toFixed(2));
  } else {
    intendedInstalment = Number((p / numInstalments).toFixed(2));
  }

  let remainingPrincipal = p;
  let totalInterest = 0;
  const schedule = [];
  const start = new Date(startDate);

  for (let i = 1; i <= numInstalments; i++) {
    // Due date = start + (i * intervalDays)
    const dueDate = new Date(start.getTime() + i * intervalDays * 24 * 60 * 60 * 1000);

    // Interest for this period on remaining principal
    let interestPart = Number((remainingPrincipal * periodicRate).toFixed(2));
    let principalPart = Number((intendedInstalment - interestPart).toFixed(2));
    let instalmentTotal = intendedInstalment;

    // Handle last instalment adjustment for exact balancing
    if (i === numInstalments || principalPart > remainingPrincipal) {
      principalPart = remainingPrincipal;
      instalmentTotal = Number((principalPart + interestPart).toFixed(2));
      remainingPrincipal = 0;
    } else {
      remainingPrincipal = Number((remainingPrincipal - principalPart).toFixed(2));
    }

    totalInterest = Number((totalInterest + interestPart).toFixed(2));

    schedule.push({
      instalmentNumber: i,
      dueDate,
      principalDue: principalPart,
      interestDue: interestPart,
      feeDue: 0,
      totalDue: instalmentTotal,
      balanceRemaining: remainingPrincipal,
      status: "UPCOMING"
    });
  }

  const totalPayable = Number((p + totalInterest).toFixed(2));

  return {
    principal: p,
    annualRatePercent: rate,
    tenureMonths: tenure,
    frequency,
    numInstalments,
    estimatedInstalment: intendedInstalment, // Preserves intended periodic instalment, not the adjusted last payment
    totalInterest,
    totalPayable,
    schedule
  };
}

/**
 * Calculates processing fee and GST
 */
export function calculateProcessingFee({
  amount,
  feeType = "PERCENTAGE",
  feeValue = 2.0,
  gstPercent = 18.0
}) {
  const amt = Number(amount);
  let fee = 0;

  if (feeType === "PERCENTAGE") {
    fee = Number(((amt * Number(feeValue)) / 100).toFixed(2));
  } else {
    fee = Number(Number(feeValue).toFixed(2));
  }

  const gst = Number(((fee * Number(gstPercent)) / 100).toFixed(2));
  const totalFee = Number((fee + gst).toFixed(2));
  const netDisbursement = Number((amt - totalFee).toFixed(2));

  return {
    baseAmount: amt,
    processingFee: fee,
    gst,
    totalFee,
    netDisbursement: Math.max(0, netDisbursement)
  };
}
