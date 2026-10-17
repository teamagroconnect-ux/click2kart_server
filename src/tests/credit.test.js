import assert from "assert";
import crypto from "crypto";
import {
  calculateDailyCompoundedInterest,
  calculateAccruedInterest,
  generateRepaymentSchedule,
  calculateProcessingFee
} from "../services/interest.service.js";
import {
  verifyAutoPayWebhookSignature,
  initializeAutoPayMandate
} from "../services/autopay.service.js";
import {
  allocateRepayment,
  evaluateFacilityInvariants
} from "../services/businessCredit.service.js";

console.log("==========================================");
console.log("RUNNING CLICK2KART BUSINESS CREDIT TEST SUITE");
console.log("==========================================\n");

let passedTests = 0;
let totalTests = 0;

function test(description, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✓ PASS: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ FAIL: ${description}`);
    console.error(err);
  }
}

// ----------------------------------------------------
// 1. Daily Simple vs. Daily Compounding Interest
// ----------------------------------------------------
test("Daily Simple Interest: P = ₹1,00,000, 18% p.a., 30 days (ACTUAL_365)", () => {
  const principal = 100000;
  const rate = 18;
  const days = 30;

  const result = calculateAccruedInterest({
    principal,
    annualRatePercent: rate,
    days,
    dayCountConvention: "ACTUAL_365",
    interestMethod: "DAILY_SIMPLE"
  });

  // Simple: P * (r / 365) * n = 100000 * (0.18 / 365) * 30 = 1479.45
  const expectedInterest = Number((principal * (rate / 100 / 365) * days).toFixed(2));

  assert.strictEqual(result.principal, 100000);
  assert.strictEqual(result.days, 30);
  assert.strictEqual(result.method, "DAILY_SIMPLE");
  assert.strictEqual(result.interestAccrued, expectedInterest);
  assert.strictEqual(result.totalPayable, Number((principal + expectedInterest).toFixed(2)));
  assert.strictEqual(result.interestAccrued, 1479.45);
});

test("Daily Compounded Interest: P = ₹1,00,000, 18% p.a., 30 days (ACTUAL_365)", () => {
  const principal = 100000;
  const rate = 18;
  const days = 30;

  const result = calculateAccruedInterest({
    principal,
    annualRatePercent: rate,
    days,
    dayCountConvention: "ACTUAL_365",
    interestMethod: "DAILY_COMPOUNDING"
  });

  // Compounded: P * (1 + 0.18/365)^30 - P = 1490.39
  const dailyRate = rate / 100 / 365;
  const expectedTotal = principal * Math.pow(1 + dailyRate, days);
  const expectedInterest = Number((expectedTotal - principal).toFixed(2));

  assert.strictEqual(result.principal, 100000);
  assert.strictEqual(result.days, 30);
  assert.strictEqual(result.method, "DAILY_COMPOUNDING");
  assert.strictEqual(result.interestAccrued, expectedInterest);
  assert.strictEqual(result.interestAccrued, 1490.08);
  // Compounded interest must be strictly greater than simple interest for days > 1
  assert(result.interestAccrued > 1479.45, "Compounded interest must exceed simple interest");
});

test("Daily compounding interest: Backward compatibility alias", () => {
  const result = calculateDailyCompoundedInterest({
    principal: 100000,
    annualRatePercent: 18,
    days: 30
  });

  assert.strictEqual(result.interestAccrued, 1490.08);
  assert.strictEqual(result.totalPayable, 101490.08);
});

test("Daily interest boundary: 0 days or 0 principal produces 0 interest", () => {
  const zeroDays = calculateAccruedInterest({
    principal: 50000,
    annualRatePercent: 18,
    days: 0
  });
  assert.strictEqual(zeroDays.interestAccrued, 0);
  assert.strictEqual(zeroDays.totalPayable, 50000);

  const zeroPrincipal = calculateAccruedInterest({
    principal: 0,
    annualRatePercent: 18,
    days: 30
  });
  assert.strictEqual(zeroPrincipal.interestAccrued, 0);
  assert.strictEqual(zeroPrincipal.totalPayable, 0);
});

// ----------------------------------------------------
// 2. Strict Tenure Validation (3 to 5 Months ONLY)
// ----------------------------------------------------
test("Tenure validation: 3 months is ACCEPTED", () => {
  const result = generateRepaymentSchedule({
    principal: 50000,
    annualRatePercent: 18,
    tenureMonths: 3,
    frequency: "WEEKLY"
  });
  assert(result.schedule.length > 0, "Schedule must be generated");
  assert.strictEqual(result.schedule[0].instalmentNumber, 1);
});

test("Tenure validation: 4 months is ACCEPTED", () => {
  const result = generateRepaymentSchedule({
    principal: 50000,
    annualRatePercent: 18,
    tenureMonths: 4,
    frequency: "WEEKLY"
  });
  assert(result.schedule.length > 0);
});

test("Tenure validation: 5 months is ACCEPTED", () => {
  const result = generateRepaymentSchedule({
    principal: 50000,
    annualRatePercent: 18,
    tenureMonths: 5,
    frequency: "WEEKLY"
  });
  assert(result.schedule.length > 0);
});

test("Tenure validation: 2 months is REJECTED (< 3 months limit)", () => {
  assert.throws(
    () => {
      generateRepaymentSchedule({
        principal: 50000,
        annualRatePercent: 18,
        tenureMonths: 2,
        frequency: "WEEKLY"
      });
    },
    /between 3 and 5 months/,
    "Must throw error for tenure < 3 months"
  );
});

test("Tenure validation: 6 months is REJECTED (> 5 months limit)", () => {
  assert.throws(
    () => {
      generateRepaymentSchedule({
        principal: 50000,
        annualRatePercent: 18,
        tenureMonths: 6,
        frequency: "WEEKLY"
      });
    },
    /between 3 and 5 months/,
    "Must throw error for tenure > 5 months"
  );
});

test("Tenure validation: 12 months is REJECTED", () => {
  assert.throws(
    () => {
      generateRepaymentSchedule({
        principal: 50000,
        annualRatePercent: 18,
        tenureMonths: 12,
        frequency: "WEEKLY"
      });
    },
    /between 3 and 5 months/
  );
});

// ----------------------------------------------------
// 3. Amortization Schedule & estimatedInstalment Precision
// ----------------------------------------------------
test("Amortization Schedule: Principal sum matches exactly to the paise (Weekly 3 months)", () => {
  const principal = 75000;
  const result = generateRepaymentSchedule({
    principal,
    annualRatePercent: 18,
    tenureMonths: 3,
    frequency: "WEEKLY"
  });

  const sumPrincipal = result.schedule.reduce((sum, item) => sum + item.principalDue, 0);
  const roundedSumPrincipal = Math.round(sumPrincipal * 100) / 100;

  assert.strictEqual(
    roundedSumPrincipal,
    principal,
    `Sum of principal (${roundedSumPrincipal}) must exactly equal requested principal (${principal})`
  );

  // Check week intervals: 7 days apart
  for (let i = 1; i < result.schedule.length; i++) {
    const prevDate = new Date(result.schedule[i - 1].dueDate);
    const currDate = new Date(result.schedule[i].dueDate);
    const diffDays = Math.round((currDate - prevDate) / (1000 * 60 * 60 * 24));
    assert.strictEqual(diffDays, 7, `Instalment ${i + 1} must be exactly 7 days after previous`);
  }
});

test("Amortization Schedule: estimatedInstalment preserves intended EMI, not balancing last instalment", () => {
  const principal = 50000;
  const result = generateRepaymentSchedule({
    principal,
    annualRatePercent: 18,
    tenureMonths: 3,
    frequency: "WEEKLY"
  });

  // The estimatedInstalment must equal the intended instalment of the regular periods
  assert(result.estimatedInstalment > 0, "estimatedInstalment must be positive");
  assert.strictEqual(typeof result.estimatedInstalment, "number");

  // Regular instalments (1 to N-1) match estimatedInstalment
  for (let i = 0; i < result.schedule.length - 1; i++) {
    assert.strictEqual(result.schedule[i].totalDue, result.estimatedInstalment);
  }

  // Last instalment absorbs any remaining rounding difference
  const lastInst = result.schedule[result.schedule.length - 1];
  assert(Math.abs(lastInst.totalDue - result.estimatedInstalment) < 5.0, "Last instalment must be close to regular EMI");
});

test("Amortization Schedule: Principal sum matches exactly (Daily 3 months)", () => {
  const principal = 30000;
  const result = generateRepaymentSchedule({
    principal,
    annualRatePercent: 18,
    tenureMonths: 3,
    frequency: "DAILY"
  });

  const sumPrincipal = result.schedule.reduce((sum, item) => sum + item.principalDue, 0);
  const roundedSumPrincipal = Math.round(sumPrincipal * 100) / 100;

  assert.strictEqual(roundedSumPrincipal, principal);
});

// ----------------------------------------------------
// 4. Processing Fee Calculation
// ----------------------------------------------------
test("Processing Fee: P = ₹50,000, 2% fee, 18% GST", () => {
  const result = calculateProcessingFee({
    amount: 50000,
    feeType: "PERCENTAGE",
    feeValue: 2,
    gstPercent: 18
  });

  assert.strictEqual(result.processingFee, 1000);
  assert.strictEqual(result.gst, 180);
  assert.strictEqual(result.totalFee, 1180);
  assert.strictEqual(result.netDisbursement, 48820);
  assert.strictEqual(result.totalFee + result.netDisbursement, 50000);
});

// ----------------------------------------------------
// 5. AutoPay Mandate & Webhook Security
// ----------------------------------------------------
test("AutoPay Mandate: returns PENDING_MERCHANT_ACTIVATION and does NOT create fake order ID", async () => {
  const res = await initializeAutoPayMandate({
    facilityId: "fac_123",
    retailerId: "ret_456",
    customerEmail: "retailer@example.com",
    customerPhone: "9876543210"
  });

  assert.strictEqual(res.status, "PENDING_MERCHANT_ACTIVATION");
  assert.strictEqual(res.recurringEnabled, false);
  assert.strictEqual(res.fallbackToManual, true);
  assert.strictEqual(res.mandateId, null);
  assert(res.message.includes("e-Mandate registration is currently pending aggregator onboarding"));
});

test("AutoPay Webhook HMAC-SHA256 signature verification with raw body", () => {
  const secret = "test_autopay_webhook_secret_key_123";

  const rawPayload = JSON.stringify({
    event: "subscription.charged",
    payload: { payment: { entity: { id: "pay_12345", amount: 500000 } } }
  });

  const validSignature = crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");
  const invalidSignature = crypto.createHmac("sha256", "wrong_secret").update(rawPayload).digest("hex");

  assert.strictEqual(verifyAutoPayWebhookSignature(rawPayload, validSignature, secret), true, "Valid signature must pass");
  assert.strictEqual(verifyAutoPayWebhookSignature(rawPayload, invalidSignature, secret), false, "Tampered signature must fail");
  assert.strictEqual(verifyAutoPayWebhookSignature(rawPayload, "invalid_hex", secret), false, "Malformed signature must fail");
  assert.strictEqual(verifyAutoPayWebhookSignature(null, validSignature, secret), false, "Null payload must fail");
});

// ----------------------------------------------------
// 6. Repayment Allocation Hierarchy & Surplus Handling
// ----------------------------------------------------
test("Repayment Allocation: Small payment < interest due allocates fees then interest, 0 to principal", () => {
  const schedules = [
    {
      instalmentNumber: 1,
      feeDue: 50,
      feePaid: 0,
      interestDue: 200,
      interestPaid: 0,
      principalDue: 1000,
      principalPaid: 0,
      totalDue: 1250,
      totalPaid: 0,
      status: "DUE"
    }
  ];

  // Payment of ₹150: covers ₹50 fee + ₹100 of interest
  const alloc = allocateRepayment({
    pendingSchedules: schedules,
    principalOutstanding: 1000,
    amount: 150
  });

  assert.strictEqual(alloc.totalFeePaid, 50);
  assert.strictEqual(alloc.totalInterestPaid, 100);
  assert.strictEqual(alloc.totalPrincipalPaid, 0);
  assert.strictEqual(alloc.surplusRefundDue, 0);

  assert.strictEqual(schedules[0].feePaid, 50);
  assert.strictEqual(schedules[0].interestPaid, 100);
  assert.strictEqual(schedules[0].principalPaid, 0);
  assert.strictEqual(schedules[0].totalPaid, 150);
  assert.strictEqual(schedules[0].status, "PARTIALLY_PAID");
});

test("Repayment Allocation: Payment spanning multiple instalments", () => {
  const schedules = [
    {
      instalmentNumber: 1,
      feeDue: 0,
      feePaid: 0,
      interestDue: 150,
      interestPaid: 0,
      principalDue: 1000,
      principalPaid: 0,
      totalDue: 1150,
      totalPaid: 0,
      status: "OVERDUE"
    },
    {
      instalmentNumber: 2,
      feeDue: 0,
      feePaid: 0,
      interestDue: 140,
      interestPaid: 0,
      principalDue: 1000,
      principalPaid: 0,
      totalDue: 1140,
      totalPaid: 0,
      status: "DUE"
    }
  ];

  // Payment of ₹1500:
  // Inst 1: ₹150 interest + ₹1000 principal = ₹1150 (Fully Paid)
  // Remaining ₹350 goes to Inst 2: ₹140 interest + ₹210 principal (Partially Paid)
  const alloc = allocateRepayment({
    pendingSchedules: schedules,
    principalOutstanding: 2000,
    amount: 1500
  });

  assert.strictEqual(alloc.totalInterestPaid, 290); // 150 + 140
  assert.strictEqual(alloc.totalPrincipalPaid, 1210); // 1000 + 210
  assert.strictEqual(alloc.surplusRefundDue, 0);

  assert.strictEqual(schedules[0].status, "PAID");
  assert.strictEqual(schedules[0].totalPaid, 1150);

  assert.strictEqual(schedules[1].status, "PARTIALLY_PAID");
  assert.strictEqual(schedules[1].interestPaid, 140);
  assert.strictEqual(schedules[1].principalPaid, 210);
  assert.strictEqual(schedules[1].totalPaid, 350);
});

test("Repayment Allocation: Overpayment surplus is capped strictly at principal outstanding", () => {
  const schedules = [
    {
      instalmentNumber: 1,
      feeDue: 0,
      feePaid: 0,
      interestDue: 100,
      interestPaid: 0,
      principalDue: 1000,
      principalPaid: 0,
      totalDue: 1100,
      totalPaid: 0,
      status: "DUE"
    }
  ];

  // Facility principal outstanding is only ₹1000.
  // Retailer pays ₹2000: ₹100 interest + ₹1000 principal = ₹1100.
  // Excess ₹900 MUST NOT reduce principal below 0 and must become surplusRefundDue.
  const alloc = allocateRepayment({
    pendingSchedules: schedules,
    principalOutstanding: 1000,
    amount: 2000
  });

  assert.strictEqual(alloc.totalInterestPaid, 100);
  assert.strictEqual(alloc.totalPrincipalPaid, 1000); // Capped at principalOutstanding!
  assert.strictEqual(alloc.surplusRefundDue, 900); // ₹900 tracked as surplus refund due
  assert.strictEqual(alloc.totalInterestPaid + alloc.totalPrincipalPaid + alloc.surplusRefundDue, 2000);
});

test("Repayment Allocation: Rejects zero or negative payment amounts", () => {
  assert.throws(
    () => {
      allocateRepayment({
        pendingSchedules: [],
        principalOutstanding: 5000,
        amount: 0
      });
    },
    /strictly positive/,
    "Must throw error for 0 amount"
  );

  assert.throws(
    () => {
      allocateRepayment({
        pendingSchedules: [],
        principalOutstanding: 5000,
        amount: -100
      });
    },
    /strictly positive/,
    "Must throw error for negative amount"
  );
});

// ----------------------------------------------------
// 7. Financial Invariant Validation Engine
// ----------------------------------------------------
test("Invariant Engine: Healthy facility passes all 5 invariants with 0 discrepancies", () => {
  const facility = {
    _id: "fac_healthy",
    facilityNumber: "BCF-20261017-0001",
    status: "ACTIVE",
    disbursedAmount: 50000,
    principalPaidTotal: 10000,
    principalOutstanding: 40000,
    interestAccruedTotal: 1500,
    interestPaidTotal: 500,
    interestOutstanding: 1000,
    totalPaid: 10500, // 10000 principal + 500 interest
    totalPayable: 41000 // 40000 principal + 1000 interest
  };

  const schedules = [
    { instalmentNumber: 1, principalDue: 10000, principalPaid: 10000 },
    { instalmentNumber: 2, principalDue: 20000, principalPaid: 0 },
    { instalmentNumber: 3, principalDue: 20000, principalPaid: 0 }
  ]; // Unpaid schedule principal: 0 + 20000 + 20000 = 40000

  const transactions = [
    { type: "REPAYMENT", principalComponent: 10000, interestComponent: 500, feeComponent: 0 }
  ]; // Net repaid: 10500

  const result = evaluateFacilityInvariants({ facility, schedules, transactions });

  assert.strictEqual(result.invariantsPassed, true, "Healthy facility must pass all invariants");
  assert.strictEqual(result.discrepancies.length, 0);
  assert.strictEqual(result.metrics.principalOutstanding, 40000);
  assert.strictEqual(result.metrics.interestOutstanding, 1000);
  assert.strictEqual(result.metrics.totalPayable, 41000);
  assert.strictEqual(result.metrics.schedulePrincipalUnpaid, 40000);
  assert.strictEqual(result.metrics.netLedgerRepaid, 10500);
});

test("Invariant Engine: Detects principal arithmetic mismatch", () => {
  const facility = {
    _id: "fac_bad_principal",
    facilityNumber: "BCF-20261017-0002",
    status: "ACTIVE",
    disbursedAmount: 50000,
    principalPaidTotal: 10000,
    principalOutstanding: 35000, // Error: Should be 40000!
    interestAccruedTotal: 0,
    interestPaidTotal: 0,
    interestOutstanding: 0,
    totalPaid: 10000,
    totalPayable: 35000
  };

  const result = evaluateFacilityInvariants({ facility, schedules: [], transactions: [] });

  assert.strictEqual(result.invariantsPassed, false);
  const mismatch = result.discrepancies.find(d => d.type === "PRINCIPAL_ARITHMETIC_MISMATCH");
  assert(mismatch, "Must report PRINCIPAL_ARITHMETIC_MISMATCH");
  assert.strictEqual(mismatch.expected, 40000);
  assert.strictEqual(mismatch.actual, 35000);
});

test("Invariant Engine: Detects schedule principal mismatch", () => {
  const facility = {
    _id: "fac_bad_schedule",
    facilityNumber: "BCF-20261017-0003",
    status: "ACTIVE",
    disbursedAmount: 50000,
    principalPaidTotal: 10000,
    principalOutstanding: 40000,
    interestAccruedTotal: 0,
    interestPaidTotal: 0,
    interestOutstanding: 0,
    totalPaid: 10000,
    totalPayable: 40000
  };

  const schedules = [
    { instalmentNumber: 1, principalDue: 10000, principalPaid: 10000 },
    { instalmentNumber: 2, principalDue: 15000, principalPaid: 0 } // Only 15000 unpaid, doesn't match 40000
  ];

  const result = evaluateFacilityInvariants({ facility, schedules, transactions: [] });

  assert.strictEqual(result.invariantsPassed, false);
  const mismatch = result.discrepancies.find(d => d.type === "SCHEDULE_PRINCIPAL_MISMATCH");
  assert(mismatch, "Must report SCHEDULE_PRINCIPAL_MISMATCH");
  assert.strictEqual(mismatch.scheduleTotal, 15000);
  assert.strictEqual(mismatch.facilityOutstanding, 40000);
});

test("Invariant Engine: Detects ledger payment mismatch and accounts for reversals", () => {
  const facility = {
    _id: "fac_bad_ledger",
    facilityNumber: "BCF-20261017-0004",
    status: "ACTIVE",
    disbursedAmount: 50000,
    principalPaidTotal: 10000,
    principalOutstanding: 40000,
    interestAccruedTotal: 0,
    interestPaidTotal: 0,
    interestOutstanding: 0,
    totalPaid: 10000,
    totalPayable: 40000
  };

  // Ledger only shows ₹8,000 repaid (₹10,000 minus ₹2,000 reversal) but facility claims totalPaid is 10000
  const transactions = [
    { type: "REPAYMENT", principalComponent: 10000, interestComponent: 0, feeComponent: 0 },
    { type: "REVERSAL", principalComponent: 2000, interestComponent: 0, feeComponent: 0 }
  ];

  const result = evaluateFacilityInvariants({ facility, schedules: [], transactions });

  assert.strictEqual(result.invariantsPassed, false);
  const mismatch = result.discrepancies.find(d => d.type === "LEDGER_PAYMENT_MISMATCH");
  assert(mismatch, "Must report LEDGER_PAYMENT_MISMATCH");
  assert.strictEqual(mismatch.ledgerNetPaid, 8000);
  assert.strictEqual(mismatch.facilityTotalPaid, 10000);
});

console.log("\n==========================================");
console.log(`TEST RESULTS: ${passedTests} / ${totalTests} passed`);
console.log("==========================================");

if (passedTests === totalTests) {
  console.log("ALL TESTS COMPLETED SUCCESSFULLY! ✓");
  process.exit(0);
} else {
  console.error("SOME TESTS FAILED! ✗");
  process.exit(1);
}
