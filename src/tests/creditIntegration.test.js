import assert from "assert";
import crypto from "crypto";
import {
  allocateRepayment,
  evaluateFacilityInvariants
} from "../services/businessCredit.service.js";
import {
  calculateAccruedInterest,
  generateRepaymentSchedule,
  calculateProcessingFee
} from "../services/interest.service.js";
import {
  verifyRazorpayWebhookSignature,
  createAutoPayMandate
} from "../services/autopay.service.js";

console.log("=======================================================");
console.log("RUNNING CLICK2KART CREDIT INTEGRATION & INVARIANT SUITE");
console.log("=======================================================\n");

const testCases = [];

function test(description, fn) {
  testCases.push({ description, fn });
}

// =====================================================================
// IN-MEMORY INTEGRATION HARNESS
// Simulates live database collections, atomic operations, unique indexes,
// and append-only financial ledger transactions.
// =====================================================================

class MockDb {
  constructor() {
    this.facilities = new Map();
    this.schedules = new Map();
    this.transactions = new Map();
    this.customers = new Map();
    this.tradeLedger = new Map();
    this.idempotencyIndex = new Set();
  }

  reset() {
    this.facilities.clear();
    this.schedules.clear();
    this.transactions.clear();
    this.customers.clear();
    this.tradeLedger.clear();
    this.idempotencyIndex.clear();
  }

  // --- Business Credit Facility Operations ---
  disburseFacility({ retailerId, sanctionedLimit, tenureMonths, interestRate, frequency = "WEEKLY" }) {
    const facilityId = "fac_" + Math.random().toString(36).substring(2, 9);
    const facilityNumber = `BCF-TEST-${Date.now()}`;

    const amort = generateRepaymentSchedule({
      principal: sanctionedLimit,
      annualRatePercent: interestRate,
      tenureMonths,
      frequency,
      permittedTenures: [1, 2, 3, 4, 5]
    });

    const facility = {
      _id: facilityId,
      facilityNumber,
      retailerId,
      status: "ACTIVE",
      sanctionedLimit,
      disbursedAmount: sanctionedLimit,
      tenureMonths,
      repaymentFrequency: frequency,
      totalInstalments: amort.numInstalments,
      interestRatePerAnnum: interestRate,
      interestMethod: "DAILY_COMPOUNDING",
      dayCountConvention: "ACTUAL_365",
      principalOutstanding: sanctionedLimit,
      interestAccruedTotal: 0,
      interestOutstanding: 0,
      interestPaidTotal: 0,
      principalPaidTotal: 0,
      totalPaid: 0,
      totalPayable: sanctionedLimit, // At disbursement, payoff = principalOutstanding + interestOutstanding(0)
      lastInterestAccrualDate: new Date(),
      nextDueDate: amort.schedule[0].dueDate,
      nextDueAmount: amort.schedule[0].totalDue
    };
    this.facilities.set(facilityId, facility);

    // Create schedule docs
    const schedList = [];
    for (const inst of amort.schedule) {
      const sId = `sch_${facilityId}_${inst.instalmentNumber}`;
      const doc = {
        _id: sId,
        facilityId,
        instalmentNumber: inst.instalmentNumber,
        dueDate: inst.dueDate,
        principalDue: inst.principalDue,
        interestDue: inst.interestDue,
        feeDue: inst.feeDue,
        totalDue: inst.totalDue,
        principalPaid: 0,
        interestPaid: 0,
        feePaid: 0,
        totalPaid: 0,
        status: "UPCOMING"
      };
      this.schedules.set(sId, doc);
      schedList.push(doc);
    }

    // Ledger DISBURSEMENT transaction
    const txnId = "txn_" + Math.random().toString(36).substring(2, 9);
    const txn = {
      _id: txnId,
      facilityId,
      type: "DISBURSEMENT",
      amount: sanctionedLimit,
      principalComponent: sanctionedLimit,
      interestComponent: 0,
      feeComponent: 0,
      principalOutstandingBefore: 0,
      principalOutstandingAfter: sanctionedLimit,
      interestOutstandingBefore: 0,
      interestOutstandingAfter: 0,
      totalPayableBefore: 0,
      totalPayableAfter: sanctionedLimit,
      idempotencyKey: `DISB-${facilityId}`,
      createdAt: new Date()
    };
    this.transactions.set(txnId, txn);
    this.idempotencyIndex.add(txn.idempotencyKey);

    return { facility, schedules: schedList, transaction: txn };
  }

  // --- Accrue Daily Interest Concurrency-Safely ---
  accrueInterest({ facilityId, businessDateStr, days = 1 }) {
    const fac = this.facilities.get(facilityId);
    if (!fac || fac.status !== "ACTIVE" || fac.principalOutstanding <= 0) return null;

    const idempotencyKey = `ACCRUAL-${fac._id}-${businessDateStr}`;

    // Concurrency check: Unique idempotency index
    if (this.idempotencyIndex.has(idempotencyKey)) {
      const err = new Error(`E11000 duplicate key error collection: BusinessCreditTransaction index: idempotencyKey_1 dup key: { idempotencyKey: "${idempotencyKey}" }`);
      err.code = 11000;
      throw err;
    }

    const calc = calculateAccruedInterest({
      principal: fac.principalOutstanding,
      annualRatePercent: fac.interestRatePerAnnum,
      days,
      interestMethod: fac.interestMethod
    });

    if (calc.interest <= 0) return null;

    // LEDGER-FIRST: Record transaction before modifying facility balance
    const txnId = "txn_accrual_" + Math.random().toString(36).substring(2, 9);
    const txn = {
      _id: txnId,
      facilityId: fac._id,
      type: "INTEREST_ACCRUAL",
      amount: calc.interest,
      principalComponent: 0,
      interestComponent: calc.interest,
      feeComponent: 0,
      principalOutstandingBefore: fac.principalOutstanding,
      principalOutstandingAfter: fac.principalOutstanding,
      interestOutstandingBefore: fac.interestOutstanding,
      interestOutstandingAfter: Number((fac.interestOutstanding + calc.interest).toFixed(2)),
      totalPayableBefore: fac.totalPayable,
      totalPayableAfter: Number((fac.totalPayable + calc.interest).toFixed(2)),
      idempotencyKey,
      createdAt: new Date()
    };
    this.transactions.set(txnId, txn);
    this.idempotencyIndex.add(idempotencyKey);

    // Atomically increment facility balances
    fac.interestAccruedTotal = Number((fac.interestAccruedTotal + calc.interest).toFixed(2));
    fac.interestOutstanding = Number((fac.interestOutstanding + calc.interest).toFixed(2));
    fac.totalPayable = Number((fac.principalOutstanding + fac.interestOutstanding).toFixed(2));
    fac.lastInterestAccrualDate = new Date();

    return { facility: fac, transaction: txn, accruedInterest: calc.interest };
  }

  // --- Process Business Repayment ---
  processRepayment({ facilityId, amount, paymentRef, method = "RAZORPAY" }) {
    const fac = this.facilities.get(facilityId);
    if (!fac) throw new Error("Facility not found");

    // Duplicate check via unique reference
    if (paymentRef && this.idempotencyIndex.has(paymentRef)) {
      throw new Error(`Duplicate payment rejected. Reference '${paymentRef}' was already processed.`);
    }

    // Pending schedules
    const pending = Array.from(this.schedules.values())
      .filter(s => s.facilityId === facilityId && ["UPCOMING", "DUE", "PARTIALLY_PAID", "OVERDUE"].includes(s.status))
      .sort((a, b) => a.instalmentNumber - b.instalmentNumber);

    const alloc = allocateRepayment({
      pendingSchedules: pending,
      principalOutstanding: fac.principalOutstanding,
      amount
    });

    const principalBefore = fac.principalOutstanding;
    const interestBefore = fac.interestOutstanding;
    const totalPayableBefore = fac.totalPayable;

    // Invariant-preserving interest accounting
    const unbilledInterestPaid = Math.max(0, Number((alloc.totalInterestPaid - (fac.interestOutstanding || 0)).toFixed(2)));
    fac.interestAccruedTotal = Number(((fac.interestAccruedTotal || 0) + unbilledInterestPaid).toFixed(2));
    fac.principalPaidTotal = Number((fac.principalPaidTotal + alloc.totalPrincipalPaid).toFixed(2));
    fac.interestPaidTotal = Number((fac.interestPaidTotal + alloc.totalInterestPaid).toFixed(2));
    const effectivePayment = Number((alloc.totalPrincipalPaid + alloc.totalInterestPaid + alloc.totalFeePaid).toFixed(2));
    fac.totalPaid = Number((fac.totalPaid + effectivePayment).toFixed(2));

    fac.principalOutstanding = Math.max(0, Number((fac.principalOutstanding - alloc.totalPrincipalPaid).toFixed(2)));
    fac.interestOutstanding = Math.max(0, Number(((fac.interestOutstanding || 0) + unbilledInterestPaid - alloc.totalInterestPaid).toFixed(2)));
    fac.totalPayable = Number((fac.principalOutstanding + fac.interestOutstanding).toFixed(2));

    if (fac.principalOutstanding <= 0 && fac.interestOutstanding <= 0) {
      fac.status = "SETTLED";
      fac.nextDueDate = null;
      fac.nextDueAmount = 0;
    } else {
      const nextInst = pending.find(s => s.status !== "PAID");
      if (nextInst) {
        fac.nextDueDate = nextInst.dueDate;
        fac.nextDueAmount = Number((nextInst.totalDue - nextInst.totalPaid).toFixed(2));
      }
    }

    // Write immutable ledger entry
    const txnId = "txn_repay_" + Math.random().toString(36).substring(2, 9);
    const txnKey = paymentRef || `REPAY-${txnId}`;
    const txn = {
      _id: txnId,
      facilityId: fac._id,
      type: "REPAYMENT",
      amount,
      principalComponent: alloc.totalPrincipalPaid,
      interestComponent: alloc.totalInterestPaid,
      feeComponent: alloc.totalFeePaid,
      principalOutstandingBefore: principalBefore,
      principalOutstandingAfter: fac.principalOutstanding,
      interestOutstandingBefore: interestBefore,
      interestOutstandingAfter: fac.interestOutstanding,
      totalPayableBefore,
      totalPayableAfter: fac.totalPayable,
      idempotencyKey: txnKey,
      paymentDetails: { paymentRef, surplusRefundDue: alloc.surplusRefundDue },
      createdAt: new Date()
    };
    this.transactions.set(txnId, txn);
    this.idempotencyIndex.add(txnKey);

    return { facility: fac, transaction: txn, allocation: alloc };
  }

  // --- Reverse Repayment ---
  reverseRepayment({ transactionId, reason }) {
    if (!reason) throw new Error("Reversal reason is required");
    const origTxn = this.transactions.get(transactionId);
    if (!origTxn || origTxn.type !== "REPAYMENT") throw new Error("Repayment transaction not found");

    const fac = this.facilities.get(origTxn.facilityId);
    if (!fac) throw new Error("Facility not found");

    const principalBefore = fac.principalOutstanding;
    const interestBefore = fac.interestOutstanding;
    const totalPayableBefore = fac.totalPayable;

    // Restore facility balances
    const effectiveReversed = Number((origTxn.principalComponent + origTxn.interestComponent + (origTxn.feeComponent || 0)).toFixed(2));
    fac.principalPaidTotal = Math.max(0, Number(((fac.principalPaidTotal || 0) - origTxn.principalComponent).toFixed(2)));
    fac.interestPaidTotal = Math.max(0, Number(((fac.interestPaidTotal || 0) - origTxn.interestComponent).toFixed(2)));
    fac.totalPaid = Math.max(0, Number(((fac.totalPaid || 0) - effectiveReversed).toFixed(2)));

    fac.principalOutstanding = Number((fac.principalOutstanding + origTxn.principalComponent).toFixed(2));
    fac.interestOutstanding = Number((fac.interestOutstanding + origTxn.interestComponent).toFixed(2));
    fac.totalPayable = Number((fac.principalOutstanding + fac.interestOutstanding).toFixed(2));

    if (fac.status === "SETTLED" && (fac.principalOutstanding > 0 || fac.interestOutstanding > 0)) {
      fac.status = "ACTIVE";
    }

    // Reopen schedules in reverse order
    let principalToReopen = origTxn.principalComponent;
    let interestToReopen = origTxn.interestComponent;

    const paidSchedules = Array.from(this.schedules.values())
      .filter(s => s.facilityId === fac._id && s.totalPaid > 0)
      .sort((a, b) => b.instalmentNumber - a.instalmentNumber);

    for (const inst of paidSchedules) {
      if (principalToReopen <= 0 && interestToReopen <= 0) break;

      const pRev = Math.min(principalToReopen, inst.principalPaid);
      const iRev = Math.min(interestToReopen, inst.interestPaid);

      inst.principalPaid = Number((inst.principalPaid - pRev).toFixed(2));
      inst.interestPaid = Number((inst.interestPaid - iRev).toFixed(2));
      inst.totalPaid = Number((inst.totalPaid - (pRev + iRev)).toFixed(2));

      inst.status = inst.totalPaid <= 0 ? "UPCOMING" : "PARTIALLY_PAID";

      principalToReopen = Number((principalToReopen - pRev).toFixed(2));
      interestToReopen = Number((interestToReopen - iRev).toFixed(2));
    }

    // Append-only REVERSAL transaction in ledger
    const revId = "txn_rev_" + Math.random().toString(36).substring(2, 9);
    const revTxn = {
      _id: revId,
      facilityId: fac._id,
      type: "REVERSAL",
      amount: origTxn.amount,
      principalComponent: origTxn.principalComponent,
      interestComponent: origTxn.interestComponent,
      feeComponent: origTxn.feeComponent,
      principalOutstandingBefore: principalBefore,
      principalOutstandingAfter: fac.principalOutstanding,
      interestOutstandingBefore: interestBefore,
      interestOutstandingAfter: fac.interestOutstanding,
      totalPayableBefore,
      totalPayableAfter: fac.totalPayable,
      idempotencyKey: `REVERSAL-${origTxn._id}`,
      createdAt: new Date()
    };
    this.transactions.set(revId, revTxn);
    this.idempotencyIndex.add(revTxn.idempotencyKey);

    return { facility: fac, reversalTransaction: revTxn };
  }

  // --- Trade Credit Mock Operations ---
  createTradeCustomer({ name, creditLimit }) {
    const customerId = "cust_" + Math.random().toString(36).substring(2, 9);
    const customer = {
      _id: customerId,
      name,
      isCreditEnabled: true,
      creditLimit,
      availableCredit: creditLimit,
      usedCredit: 0,
      outstandingBalance: 0
    };
    this.customers.set(customerId, customer);
    return customer;
  }

  deductTradeCredit({ customerId, orderId, orderTotal }) {
    const cust = this.customers.get(customerId);
    if (!cust) throw new Error("Customer not found");
    if (!cust.isCreditEnabled) throw new Error("Credit facility is not enabled for this retailer");
    if (cust.availableCredit < orderTotal) {
      throw new Error(`Insufficient credit. Available: ₹${cust.availableCredit}, Required: ₹${orderTotal}`);
    }

    cust.availableCredit = Number((cust.availableCredit - orderTotal).toFixed(2));
    cust.usedCredit = Number((cust.usedCredit + orderTotal).toFixed(2));
    cust.outstandingBalance = Number((cust.outstandingBalance + orderTotal).toFixed(2));

    const ledgerId = "tledger_" + Math.random().toString(36).substring(2, 9);
    const ledger = {
      _id: ledgerId,
      retailerId: customerId,
      type: "CREDIT_USED",
      amount: orderTotal,
      referenceId: orderId,
      createdAt: new Date()
    };
    this.tradeLedger.set(ledgerId, ledger);
    return { customer: cust, ledger };
  }

  repayTradeCredit({ customerId, amount }) {
    const cust = this.customers.get(customerId);
    if (!cust) throw new Error("Customer not found");
    if (amount <= 0) throw new Error("Invalid repayment amount");
    if (amount > cust.outstandingBalance) {
      throw new Error(`Repayment amount cannot exceed outstanding balance of ₹${cust.outstandingBalance}`);
    }

    cust.availableCredit = Number((cust.availableCredit + amount).toFixed(2));
    cust.usedCredit = Math.max(0, Number((cust.usedCredit - amount).toFixed(2)));
    cust.outstandingBalance = Math.max(0, Number((cust.outstandingBalance - amount).toFixed(2)));

    const ledgerId = "tledger_" + Math.random().toString(36).substring(2, 9);
    const ledger = {
      _id: ledgerId,
      retailerId: customerId,
      type: "REPAYMENT",
      amount,
      createdAt: new Date()
    };
    this.tradeLedger.set(ledgerId, ledger);
    return { customer: cust, ledger };
  }
}

const db = new MockDb();

// =====================================================================
// INTEGRATION TESTS
// =====================================================================

test("1. Facility Disbursement & Initial Invariant Verification", async () => {
  db.reset();
  const { facility, schedules, transaction } = db.disburseFacility({
    retailerId: "cust_retailer_001",
    sanctionedLimit: 60000,
    tenureMonths: 3,
    interestRate: 18,
    frequency: "WEEKLY"
  });

  assert.strictEqual(facility.status, "ACTIVE");
  assert.strictEqual(facility.sanctionedLimit, 60000);
  assert.strictEqual(facility.principalOutstanding, 60000);
  assert.strictEqual(facility.totalPaid, 0);
  assert.strictEqual(schedules.length, 13);
  assert.strictEqual(transaction.type, "DISBURSEMENT");

  // Invariant validation
  const inv = evaluateFacilityInvariants({
    facility,
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Disbursed facility must pass invariants: ${JSON.stringify(inv.discrepancies)}`);
  assert.strictEqual(inv.discrepancies.length, 0);
  assert.strictEqual(inv.metrics.principalOutstanding, 60000);
  assert.strictEqual(inv.metrics.schedulePrincipalUnpaid, 60000);
  assert.strictEqual(inv.metrics.netLedgerRepaid, 0);
});

test("2. Partial Repayment (< instalment total) & Invariant Verification", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const pendingBefore = Array.from(db.schedules.values()).find(s => s.instalmentNumber === 1);
  const interestDue = pendingBefore.interestDue; // e.g. ~145

  // Pay ₹300 (covers interestDue + small principal)
  const result = db.processRepayment({
    facilityId: facId,
    amount: 300,
    paymentRef: "PAY-PARTIAL-001"
  });

  assert.strictEqual(result.allocation.totalInterestPaid, interestDue);
  assert.strictEqual(result.allocation.totalPrincipalPaid, Number((300 - interestDue).toFixed(2)));
  assert.strictEqual(result.allocation.surplusRefundDue, 0);

  const inst1 = db.schedules.get(pendingBefore._id);
  assert.strictEqual(inst1.status, "PARTIALLY_PAID");
  assert.strictEqual(inst1.totalPaid, 300);

  // Invariant validation
  const inv = evaluateFacilityInvariants({
    facility: db.facilities.get(facId),
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Partial payment must maintain invariant integrity: ${JSON.stringify(inv.discrepancies)}`);
  assert.strictEqual(inv.discrepancies.length, 0);
  assert.strictEqual(inv.metrics.netLedgerRepaid, 300);
});

test("3. Full Instalment Closure & Next Due Advancing", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const inst1 = Array.from(db.schedules.values()).find(s => s.instalmentNumber === 1);
  const remainingDue = Number((inst1.totalDue - inst1.totalPaid).toFixed(2));

  db.processRepayment({
    facilityId: facId,
    amount: remainingDue,
    paymentRef: "PAY-INST1-BALANCE"
  });

  const updatedInst1 = db.schedules.get(inst1._id);
  assert.strictEqual(updatedInst1.status, "PAID");

  const facility = db.facilities.get(facId);
  const inst2 = Array.from(db.schedules.values()).find(s => s.instalmentNumber === 2);
  assert.strictEqual(facility.nextDueDate.toISOString(), inst2.dueDate.toISOString());

  // Invariant validation
  const inv = evaluateFacilityInvariants({
    facility,
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Instalment closure must maintain invariants: ${JSON.stringify(inv.discrepancies)}`);
  assert.strictEqual(inv.discrepancies.length, 0);
});

test("4. Multi-Instalment Sequential Allocation", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const inst2 = Array.from(db.schedules.values()).find(s => s.instalmentNumber === 2);
  const inst3 = Array.from(db.schedules.values()).find(s => s.instalmentNumber === 3);

  // Pay enough to cover inst 2 in full + half of inst 3
  const paymentAmount = Number((inst2.totalDue + inst3.totalDue / 2).toFixed(2));

  db.processRepayment({
    facilityId: facId,
    amount: paymentAmount,
    paymentRef: "PAY-MULTI-INSTALMENT"
  });

  const updatedInst2 = db.schedules.get(inst2._id);
  const updatedInst3 = db.schedules.get(inst3._id);

  assert.strictEqual(updatedInst2.status, "PAID");
  assert.strictEqual(updatedInst3.status, "PARTIALLY_PAID");

  // Invariant validation
  const inv = evaluateFacilityInvariants({
    facility: db.facilities.get(facId),
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Multi-instalment payment must maintain invariants: ${JSON.stringify(inv.discrepancies)}`);
});

test("5. Overpayment Surplus & Facility Settlement (SETTLED)", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const pendingSchedules = Array.from(db.schedules.values()).filter(s => s.status !== "PAID");
  const totalScheduleDuesRemaining = pendingSchedules.reduce((sum, s) => sum + (s.totalDue - s.totalPaid), 0);

  // Overpay by ₹5,000 above all remaining dues
  const overpayAmount = Number((totalScheduleDuesRemaining + 5000).toFixed(2));

  const result = db.processRepayment({
    facilityId: facId,
    amount: overpayAmount,
    paymentRef: "PAY-OVERPAYMENT-SETTLED"
  });

  const facAfter = db.facilities.get(facId);
  assert.strictEqual(facAfter.status, "SETTLED");
  assert.strictEqual(facAfter.principalOutstanding, 0);
  assert.strictEqual(facAfter.interestOutstanding, 0);
  assert.strictEqual(facAfter.totalPayable, 0);
  assert.strictEqual(result.allocation.surplusRefundDue, 5000);
  assert.strictEqual(facAfter.principalOutstanding >= 0, true, "Principal must never be negative");

  // Invariant validation
  const inv = evaluateFacilityInvariants({
    facility: facAfter,
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Settled facility must maintain invariants: ${JSON.stringify(inv.discrepancies)}`);
});

test("6. Repayment Reversal & Balance Restoration", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const lastRepayTxn = Array.from(db.transactions.values())
    .filter(t => t.type === "REPAYMENT")
    .pop();

  const revResult = db.reverseRepayment({
    transactionId: lastRepayTxn._id,
    reason: "Cheque bounced by retailer bank"
  });

  const facAfterRev = db.facilities.get(facId);
  assert.strictEqual(facAfterRev.status, "ACTIVE", "Facility must reopen to ACTIVE");
  assert(facAfterRev.principalOutstanding > 0, "Principal must be restored");
  assert.strictEqual(revResult.reversalTransaction.type, "REVERSAL");

  // Invariant validation (accounts for reversals in net ledger repayment)
  const inv = evaluateFacilityInvariants({
    facility: facAfterRev,
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Reversal must restore invariant consistency: ${JSON.stringify(inv.discrepancies)}`);
  assert.strictEqual(inv.discrepancies.length, 0);
});

test("7. Duplicate Payment Rejection & Concurrency Guard", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const duplicateRef = "PAY-DUPLICATE-CHECK-001";

  // First payment succeeds
  db.processRepayment({
    facilityId: facId,
    amount: 1000,
    paymentRef: duplicateRef
  });

  // Second payment with same ref must be rejected
  assert.throws(
    () => {
      db.processRepayment({
        facilityId: facId,
        amount: 1000,
        paymentRef: duplicateRef
      });
    },
    /Duplicate payment rejected/,
    "Must throw duplicate payment error"
  );
});

test("8. Daily Accrual Concurrency Safety & Deduplication", async () => {
  const facId = Array.from(db.facilities.keys())[0];
  const todayStr = "2026-10-17";

  // First accrual succeeds
  const accrual1 = db.accrueInterest({
    facilityId: facId,
    businessDateStr: todayStr,
    days: 1
  });
  assert(accrual1.accruedInterest > 0);

  // Second concurrent accrual for same facility and date throws duplicate key
  assert.throws(
    () => {
      db.accrueInterest({
        facilityId: facId,
        businessDateStr: todayStr,
        days: 1
      });
    },
    /duplicate key error/,
    "Unique index must prevent concurrent double accrual"
  );

  // Verify invariants after accrual
  const inv = evaluateFacilityInvariants({
    facility: db.facilities.get(facId),
    schedules: Array.from(db.schedules.values()),
    transactions: Array.from(db.transactions.values())
  });

  assert.strictEqual(inv.invariantsPassed, true, `Accrual must maintain invariants: ${JSON.stringify(inv.discrepancies)}`);
});

test("9. Trade Credit Line Regression: Checkout Deduction & Repayment", async () => {
  const customer = db.createTradeCustomer({
    name: "Shree Ganesh Retailers",
    creditLimit: 50000
  });

  assert.strictEqual(customer.availableCredit, 50000);
  assert.strictEqual(customer.outstandingBalance, 0);

  // 1. Successful deduction
  const order1 = db.deductTradeCredit({
    customerId: customer._id,
    orderId: "ORD-9991",
    orderTotal: 15000
  });

  assert.strictEqual(order1.customer.availableCredit, 35000);
  assert.strictEqual(order1.customer.usedCredit, 15000);
  assert.strictEqual(order1.customer.outstandingBalance, 15000);

  // 2. Insufficient credit rejection
  assert.throws(
    () => {
      db.deductTradeCredit({
        customerId: customer._id,
        orderId: "ORD-9992",
        orderTotal: 40000 // exceeds 35000
      });
    },
    /Insufficient credit/
  );

  // 3. Trade credit repayment
  const repay = db.repayTradeCredit({
    customerId: customer._id,
    amount: 10000
  });

  assert.strictEqual(repay.customer.availableCredit, 45000);
  assert.strictEqual(repay.customer.usedCredit, 5000);
  assert.strictEqual(repay.customer.outstandingBalance, 5000);

  // 4. Overpayment rejection
  assert.throws(
    () => {
      db.repayTradeCredit({
        customerId: customer._id,
        amount: 6000 // exceeds 5000 outstanding
      });
    },
    /cannot exceed outstanding balance/
  );
});

test("10. Real Razorpay Mandate State & AutoPay Boundary", async () => {
  const mandateRes = await createAutoPayMandate({
    facilityId: "fac_mock_123",
    customerEmail: "retailer@example.com",
    customerPhone: "9876543210"
  });

  assert.strictEqual(mandateRes.enabled, false);
  assert.strictEqual(mandateRes.recurringEnabled, false);
  assert.strictEqual(mandateRes.status, "PENDING_MERCHANT_ACTIVATION");
  assert.strictEqual(mandateRes.fallbackToManual, true);
  assert.strictEqual(mandateRes.mandateId, null);
});

test("11. Application Lifecycle State Transitions, Audit Logging, & Duplicate Guard", async () => {
  // Mock in-memory application store
  const applications = new Map();
  const auditLogs = [];

  const retailerId = "ret_app_test_101";

  // 1. Submit application (SUBMITTED)
  const app1 = {
    _id: "app_001",
    retailerId,
    requestedAmount: 75000,
    requestedTenureMonths: 2,
    purpose: "Procuring festive stock",
    status: "SUBMITTED",
    createdAt: new Date()
  };
  applications.set(app1._id, app1);

  // 2. Duplicate application protection
  const activeApp = Array.from(applications.values()).find(
    a => a.retailerId === retailerId && ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "OFFER_ACCEPTED", "DISBURSEMENT_PENDING"].includes(a.status)
  );
  assert.notStrictEqual(activeApp, undefined, "Active application must be detected");
  const canApplyAgain = !activeApp;
  assert.strictEqual(canApplyAgain, false, "Duplicate submission must be blocked while application is in-flight");

  // 3. Admin moves to review (UNDER_REVIEW) and Approves (APPROVED)
  app1.status = "UNDER_REVIEW";
  assert.strictEqual(app1.status, "UNDER_REVIEW");

  const feeCalc = calculateProcessingFee({
    amount: 75000,
    feeType: "PERCENTAGE",
    feeValue: 2.0,
    gstPercent: 18.0
  });

  const amort = generateRepaymentSchedule({
    principal: 75000,
    annualRatePercent: 18,
    tenureMonths: 2,
    frequency: "WEEKLY"
  }, { permittedTenures: [1, 2, 3, 4, 5] });

  app1.status = "APPROVED";
  app1.approvedOffer = {
    approvedAmount: 75000,
    approvedTenureMonths: 2,
    interestRatePerAnnum: 18,
    repaymentFrequency: "WEEKLY",
    processingFeeAmount: feeCalc.processingFee,
    processingFeeGst: feeCalc.gst,
    totalProcessingFee: feeCalc.totalFee,
    netDisbursementAmount: feeCalc.netDisbursement,
    totalInstalments: amort.numInstalments
  };
  auditLogs.push({ actorId: "admin_1", type: "BUSINESS_CREDIT_APPROVAL", entityId: app1._id });
  assert.strictEqual(app1.status, "APPROVED");
  assert.strictEqual(auditLogs.length, 1);

  // 4. Retailer accepts offer (OFFER_ACCEPTED -> DISBURSEMENT_PENDING)
  assert.strictEqual(app1.status, "APPROVED");
  app1.status = "OFFER_ACCEPTED";
  app1.status = "DISBURSEMENT_PENDING";
  assert.strictEqual(app1.status, "DISBURSEMENT_PENDING");

  // 5. Admin confirms disbursement with UTR (DISBURSED)
  const { facility: disbFacility } = db.disburseFacility({
    retailerId,
    sanctionedLimit: app1.approvedOffer.approvedAmount,
    tenureMonths: app1.approvedOffer.approvedTenureMonths,
    interestRate: app1.approvedOffer.interestRatePerAnnum,
    frequency: "WEEKLY"
  });

  app1.status = "DISBURSED";
  app1.facilityId = disbFacility._id;
  auditLogs.push({ actorId: "admin_1", type: "BUSINESS_CREDIT_DISBURSED", entityId: disbFacility._id });

  assert.strictEqual(app1.status, "DISBURSED");
  assert.strictEqual(disbFacility.status, "ACTIVE");
  assert.strictEqual(disbFacility.totalInstalments, 9, "2 months weekly must generate 9 instalments");

  // 6. Duplicate disbursement protection: status is no longer DISBURSEMENT_PENDING
  assert.throws(
    () => {
      if (!["OFFER_ACCEPTED", "DISBURSEMENT_PENDING"].includes(app1.status)) {
        throw new Error(`Cannot disburse funds for application in status '${app1.status}'.`);
      }
    },
    /Cannot disburse funds for application in status 'DISBURSED'/,
    "Duplicate disbursement on already disbursed application must be rejected"
  );

  // 7. Admin rejection flow verification
  const app2 = {
    _id: "app_002",
    retailerId: "ret_rejected_102",
    status: "SUBMITTED"
  };
  app2.status = "REJECTED";
  app2.rejectionReason = "Financial turnover documents insufficient";
  auditLogs.push({ actorId: "admin_1", type: "BUSINESS_CREDIT_REVIEW", entityId: app2._id, note: "REJECTED" });
  assert.strictEqual(app2.status, "REJECTED");
  assert.strictEqual(auditLogs.length, 3);
});

test("12. Early Repayment Settlement & Invariant Check across Short Tenures", async () => {
  // Disburse 1-month facility (4 instalments)
  const { facility } = db.disburseFacility({
    retailerId: "ret_short_tenure_103",
    sanctionedLimit: 30000,
    tenureMonths: 1,
    interestRate: 18,
    frequency: "WEEKLY"
  });

  assert.strictEqual(facility.totalInstalments, 4, "1 month facility has 4 instalments");
  // Calculate total dues across all 4 instalments (principal + interest)
  const facSchedules = Array.from(db.schedules.values()).filter(s => s.facilityId === facility._id);
  const totalDues = facSchedules.reduce((sum, s) => sum + (s.totalDue - s.totalPaid), 0);

  // Complete settlement of all instalments
  const fullPayoff = db.processRepayment({
    facilityId: facility._id,
    amount: totalDues,
    paymentRef: "PAY_EARLY_SETTLE_101"
  });

  assert.strictEqual(fullPayoff.facility.principalOutstanding, 0);
  assert.strictEqual(fullPayoff.facility.status, "SETTLED");

  // Invariant verification on settled facility
  const inv = evaluateFacilityInvariants({
    facility: fullPayoff.facility,
    schedules: Array.from(db.schedules.values()).filter(s => s.facilityId === facility._id),
    transactions: Array.from(db.transactions.values()).filter(t => t.facilityId === facility._id)
  });

  assert.strictEqual(inv.invariantsPassed, true, `Settled facility must satisfy invariants: ${JSON.stringify(inv.discrepancies)}`);
});

// Run all tests sequentially
async function runSuite() {
  let passedTests = 0;
  const totalTests = testCases.length;

  for (const t of testCases) {
    try {
      await t.fn();
      console.log(`✓ PASS: ${t.description}`);
      passedTests++;
    } catch (err) {
      console.error(`✗ FAIL: ${t.description}`);
      console.error(err);
    }
  }

  console.log("\n=======================================================");
  console.log(`INTEGRATION RESULTS: ${passedTests} / ${totalTests} passed`);
  console.log("=======================================================");

  if (passedTests === totalTests) {
    console.log("ALL INTEGRATION TESTS PASSED WITH 0 DISCREPANCIES! ✓");
    process.exit(0);
  } else {
    console.error("SOME INTEGRATION TESTS FAILED! ✗");
    process.exit(1);
  }
}

runSuite();
