function getCurrentSessionId_() {
  const id = settingsMap_().CurrentSessionID;
  if (!id) throw new Error('Set an active academic session before recording this operation.');
  const session = getRecords_('Sessions').find(function (row) { return row.SessionID === id && row.Status === 'Active'; });
  if (!session) throw new Error('The current session is not active. Select another session.');
  return id;
}

function recordFinancialTransaction_(actor, detail) {
  const amount = money_(detail.amount, 'Transaction amount');
  const transaction = {
    TransactionID: newId_(),
    Date: optionalDate_(detail.date) || today_(),
    SessionID: detail.sessionId || getCurrentSessionId_(),
    TransactionType: detail.type,
    ReferenceID: detail.referenceId,
    ReferenceNumber: detail.referenceNumber,
    Description: requiredText_(detail.description, 'Description', 250),
    Account: detail.account,
    PaymentMethod: detail.paymentMethod,
    Debit: detail.direction === 'out' ? amount : 0,
    Credit: detail.direction === 'in' ? amount : 0,
    Amount: amount,
    StudentID: detail.studentId || '',
    StaffID: detail.staffId || '',
    CreatedBy: actor.Name,
    CreatedAt: now_(),
    Status: 'Active'
  };
  appendTransaction_(transaction);
  return transaction;
}

function refundFee_(actor, payload) {
  const paymentId = requiredText_(payload.paymentId, 'Original payment', 50);
  const reason = requiredText_(payload.reason, 'Refund reason', 300);
  const amount = money_(payload.amount, 'Refund amount');
  if (amount <= 0) throw new Error('Refund amount must be greater than zero.');
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const payment = getRecords_('FeePayments').find(function (row) { return row.PaymentID === paymentId && row.Status === 'Active'; });
    if (!payment) throw new Error('An active fee payment was not found.');
    const refunded = getRecords_('FeeRefunds').filter(function (row) {
      return row.PaymentID === paymentId && row.Status === 'Active';
    }).reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0);
    if (amount > Number(payment.Amount) - refunded) throw new Error('Refund exceeds the unrefunded payment amount.');
    const refundId = newId_();
    const refundNo = nextNumber_('REF');
    const transaction = recordFinancialTransaction_(actor, {
      type: 'FEE_REFUND', referenceId: refundId, referenceNumber: refundNo,
      description: 'Fee refund - ' + payment.ReceiptNo, amount: amount, direction: 'out',
      sessionId: payment.SessionID, studentId: payment.StudentID, account: account,
      paymentMethod: method, date: payload.date
    });
    const refund = {
      RefundID: refundId, RefundNo: refundNo, PaymentID: paymentId,
      StudentID: payment.StudentID, SessionID: payment.SessionID,
      RefundDate: transaction.Date, Amount: amount,
      Reason: reason,
      PaymentMethod: method, ApprovedBy: optionalText_(payload.approvedBy, 100) || actor.Name,
      ProcessedBy: actor.Name, TransactionID: transaction.TransactionID,
      Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('FeeRefunds', refund);
    refreshStudentFee_(payment.StudentID, payment.SessionID);
    audit_(actor, 'REFUND', 'FeeRefunds', refundId, refund);
    return refund;
  });
}

function saveConcession_(actor, payload) {
  const studentId = requiredText_(payload.studentId, 'Student', 50);
  const type = String(payload.concessionType || 'Fixed');
  if (['Fixed', 'Percentage'].indexOf(type) === -1) throw new Error('Choose Fixed or Percentage concession.');
  return withDatabaseLock_(function () {
    const student = getRecords_('Students').find(function (row) { return row.StudentID === studentId && row.Status === 'Active'; });
    if (!student) throw new Error('Active student was not found.');
    const originalFee = Number(student.FinalFee || 0);
    const amount = type === 'Percentage'
      ? Math.round(originalFee * money_(payload.percentage, 'Concession percentage') / 100 * 100) / 100
      : money_(payload.fixedAmount, 'Concession amount');
    if (type === 'Percentage' && Number(payload.percentage) > 100) throw new Error('Concession percentage cannot exceed 100%.');
    if (amount <= 0 || amount > originalFee) throw new Error('Concession must be positive and cannot exceed the remaining fee.');
    const concession = {
      ConcessionID: newId_(), StudentID: studentId, SessionID: student.SessionID,
      OriginalFee: originalFee, ConcessionType: type, Percentage: type === 'Percentage' ? Number(payload.percentage) : 0,
      FixedAmount: type === 'Fixed' ? amount : 0, ConcessionAmount: amount,
      Reason: requiredText_(payload.reason, 'Concession reason', 300),
      ApprovedBy: optionalText_(payload.approvedBy, 100) || actor.Name,
      Date: optionalDate_(payload.date) || today_(), Remarks: optionalText_(payload.remarks, 300), Status: 'Active'
    };
    appendRecord_('Concessions', concession);
    updateRecord_('Students', 'StudentID', studentId, { FinalFee: originalFee - amount, Concession: Number(student.Concession || 0) + amount, UpdatedAt: now_() });
    appendRecord_('StudentFees', {
      StudentFeeID: newId_(), StudentID: studentId, SessionID: student.SessionID,
      FeeType: 'Concession', Amount: 0, PaidAmount: 0, ConcessionAmount: amount,
      RefundAmount: 0, Balance: 0, Status: 'Active', CreatedAt: now_()
    });
    const transaction = recordFinancialTransaction_(actor, {
      type: 'CONCESSION', referenceId: concession.ConcessionID,
      referenceNumber: nextNumber_('CON'), description: 'Fee concession - ' + student.StudentName,
      amount: amount, direction: 'none', sessionId: student.SessionID, studentId: studentId,
      account: 'Non-cash', paymentMethod: 'Other', date: concession.Date
    });
    concession.TransactionID = transaction.TransactionID;
    updateRecord_('Concessions', 'ConcessionID', concession.ConcessionID, { TransactionID: transaction.TransactionID });
    refreshStudentFee_(studentId, student.SessionID);
    audit_(actor, 'CONCESSION', 'Concessions', concession.ConcessionID, concession);
    return concession;
  });
}

function refreshStudentFee_(studentId, sessionId) {
  const fee = getRecords_('StudentFees').find(function (row) {
    return row.StudentID === studentId && row.SessionID === sessionId && row.FeeType !== 'Concession' && row.Status !== 'Cancelled';
  });
  if (!fee) return;
  const payments = getRecords_('FeePayments').filter(function (row) {
    return row.StudentID === studentId && row.SessionID === sessionId && row.Status === 'Active';
  }).reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0);
  const refunds = getRecords_('FeeRefunds').filter(function (row) {
    return row.StudentID === studentId && row.SessionID === sessionId && row.Status === 'Active';
  }).reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0);
  const student = getRecords_('Students').find(function (row) { return row.StudentID === studentId; });
  const concessions = student ? Number(student.Concession || 0) : Number(fee.ConcessionAmount || 0);
  const amount = Number(student ? student.FinalFee : fee.Amount);
  const balance = Math.max(0, amount - payments + refunds);
  updateRecord_('StudentFees', 'StudentFeeID', fee.StudentFeeID, {
    Amount: amount, PaidAmount: payments, RefundAmount: refunds,
    ConcessionAmount: concessions, Balance: balance,
    Status: balance === 0 ? 'Paid' : 'Due'
  });
}

function saveIncome_(actor, payload) {
  const amount = money_(payload.amount, 'Income amount');
  if (amount <= 0) throw new Error('Income amount must be greater than zero.');
  const description = requiredText_(payload.description, 'Description', 250);
  const receivedFrom = requiredText_(payload.receivedFrom, 'Received from', 100);
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const category = resolveCategory_('IncomeCategories', payload.category, 'INC');
    const incomeId = newId_();
    const receiptNo = nextNumber_('INC');
    const sessionId = payload.sessionId || getCurrentSessionId_();
    const date = optionalDate_(payload.date) || today_();
    const transaction = recordFinancialTransaction_(actor, {
      type: 'INCOME', referenceId: incomeId, referenceNumber: receiptNo,
      description: description,
      amount: amount, direction: 'in', sessionId: sessionId, account: account,
      paymentMethod: method, date: date
    });
    const row = {
      IncomeID: incomeId, ReceiptNo: receiptNo, Date: date, CategoryID: category.CategoryID,
      CategoryName: category.CategoryName, ReceivedFrom: receivedFrom,
      Description: description, Amount: amount,
      PaymentMethod: method, Reference: optionalText_(payload.reference, 100), SessionID: sessionId,
      ReceivedBy: actor.Name, TransactionID: transaction.TransactionID, Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('Income', row);
    appendRecord_('IncomeReceipts', { ReceiptID: newId_(), ReceiptNo: receiptNo, IncomeID: incomeId, CreatedAt: now_() });
    audit_(actor, 'CREATE', 'Income', incomeId, row);
    return row;
  });
}

function refundIncome_(actor, payload) {
  const incomeId = requiredText_(payload.incomeId, 'Income', 50);
  const reason = requiredText_(payload.reason, 'Refund reason', 300);
  const amount = money_(payload.amount, 'Refund amount');
  if (amount <= 0) throw new Error('Refund amount must be greater than zero.');
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const income = getRecords_('Income').find(function (row) { return row.IncomeID === incomeId && row.Status === 'Active'; });
    if (!income) throw new Error('Active income record was not found.');
    const prior = getRecords_('IncomeRefunds').filter(function (row) { return row.IncomeID === incomeId && row.Status === 'Active'; })
      .reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0);
    if (amount > Number(income.Amount) - prior) throw new Error('Refund exceeds the unrefunded income amount.');
    const refundId = newId_();
    const refundNo = nextNumber_('IRF');
    const transaction = recordFinancialTransaction_(actor, {
      type: 'INCOME_REFUND', referenceId: refundId, referenceNumber: refundNo,
      description: 'Income refund - ' + income.ReceiptNo, amount: amount, direction: 'out',
      sessionId: income.SessionID, account: account, paymentMethod: method, date: payload.date
    });
    const row = {
      RefundID: refundId, RefundNo: refundNo, IncomeID: incomeId, Date: transaction.Date,
      Amount: amount, Reason: reason,
      PaymentMethod: method, ApprovedBy: optionalText_(payload.approvedBy, 100) || actor.Name,
      TransactionID: transaction.TransactionID, Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('IncomeRefunds', row);
    audit_(actor, 'REFUND', 'IncomeRefunds', refundId, row);
    return row;
  });
}

function saveExpense_(actor, payload) {
  const amount = money_(payload.amount, 'Expense amount');
  if (amount <= 0) throw new Error('Expense amount must be greater than zero.');
  const description = requiredText_(payload.description, 'Description', 250);
  const paidTo = requiredText_(payload.paidTo, 'Paid to', 100);
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const category = resolveCategory_('ExpenseCategories', payload.category, 'EXP');
    const expenseId = newId_();
    const voucherNo = nextNumber_('EXP');
    const sessionId = payload.sessionId || getCurrentSessionId_();
    const date = optionalDate_(payload.date) || today_();
    const transaction = recordFinancialTransaction_(actor, {
      type: 'EXPENSE', referenceId: expenseId, referenceNumber: voucherNo,
      description: description,
      amount: amount, direction: 'out', sessionId: sessionId, account: account,
      paymentMethod: method, date: date
    });
    const row = {
      ExpenseID: expenseId, VoucherNo: voucherNo, Date: date, CategoryID: category.CategoryID,
      CategoryName: category.CategoryName, PaidTo: paidTo,
      Description: description, Amount: amount,
      PaymentMethod: method, Reference: optionalText_(payload.reference, 100), SessionID: sessionId,
      ApprovedBy: optionalText_(payload.approvedBy, 100) || actor.Name, PaidBy: actor.Name,
      TransactionID: transaction.TransactionID, Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('Expenses', row);
    appendRecord_('ExpenseVouchers', { VoucherID: newId_(), VoucherNo: voucherNo, ExpenseID: expenseId, CreatedAt: now_() });
    audit_(actor, 'CREATE', 'Expenses', expenseId, row);
    return row;
  });
}

function refundExpense_(actor, payload) {
  const expenseId = requiredText_(payload.expenseId, 'Expense', 50);
  const reason = requiredText_(payload.reason, 'Reversal reason', 300);
  const receivedFrom = requiredText_(payload.receivedFrom, 'Received from', 100);
  const amount = money_(payload.amount, 'Reversal amount');
  if (amount <= 0) throw new Error('Reversal amount must be greater than zero.');
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const expense = getRecords_('Expenses').find(function (row) { return row.ExpenseID === expenseId && row.Status === 'Active'; });
    if (!expense) throw new Error('Active expense record was not found.');
    const prior = getRecords_('ExpenseRefunds').filter(function (row) { return row.ExpenseID === expenseId && row.Status === 'Active'; })
      .reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0);
    if (amount > Number(expense.Amount) - prior) throw new Error('Reversal exceeds the unrefunded expense amount.');
    const refundId = newId_();
    const refundNo = nextNumber_('ERF');
    const transaction = recordFinancialTransaction_(actor, {
      type: 'EXPENSE_REFUND', referenceId: refundId, referenceNumber: refundNo,
      description: 'Expense reversal - ' + expense.VoucherNo, amount: amount,
      direction: 'in', sessionId: expense.SessionID, account: account,
      paymentMethod: method, date: payload.date
    });
    const row = {
      RefundID: refundId, RefundNo: refundNo, ExpenseID: expenseId, Date: transaction.Date,
      Amount: amount, Reason: reason, ReceivedFrom: receivedFrom,
      PaymentMethod: method, ApprovedBy: optionalText_(payload.approvedBy, 100) || actor.Name,
      TransactionID: transaction.TransactionID, Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('ExpenseRefunds', row);
    audit_(actor, 'REFUND', 'ExpenseRefunds', refundId, row);
    return row;
  });
}

function resolveCategory_(sheetName, value, prefix) {
  const name = requiredText_(value, 'Category', 80);
  const rows = getRecords_(sheetName);
  let category = rows.find(function (row) { return row.CategoryName.toLowerCase() === name.toLowerCase() && row.Status === 'Active'; });
  if (!category) {
    category = { CategoryID: newId_(), CategoryName: name, Status: 'Active' };
    appendRecord_(sheetName, category);
  }
  return category;
}

function saveStaff_(actor, payload) {
  return withDatabaseLock_(function () {
    const row = {
      StaffID: newId_(), PhotoFileId: '', PhotoUrl: '',
      Name: requiredText_(payload.name, 'Staff name', 100),
      FatherMotherName: optionalText_(payload.fatherMotherName, 100),
      DateOfBirth: optionalDate_(payload.dateOfBirth), Gender: optionalText_(payload.gender, 20),
      Mobile: requiredText_(payload.mobile, 'Mobile number', 20),
      Email: optionalText_(payload.email, 120), Address: optionalText_(payload.address, 500),
      JoiningDate: optionalDate_(payload.joiningDate) || today_(),
      Designation: requiredText_(payload.designation, 'Designation', 80),
      Department: optionalText_(payload.department, 80), Qualification: optionalText_(payload.qualification, 100),
      SalaryType: optionalText_(payload.salaryType, 40) || 'Monthly',
      BasicSalary: money_(payload.basicSalary || 0, 'Basic salary'),
      BankName: optionalText_(payload.bankName, 100), AccountNumber: optionalText_(payload.accountNumber, 50),
      IFSC: optionalText_(payload.ifsc, 20), UPIID: optionalText_(payload.upiId, 100),
      PAN: optionalText_(payload.pan, 20), Status: 'Active',
      Remarks: optionalText_(payload.remarks, 300), CreatedAt: now_()
    };
    appendRecord_('Staff', row);
    audit_(actor, 'CREATE', 'Staff', row.StaffID, row);
    return row;
  });
}

function disableRecord_(actor, payload, type) {
  const isStudent = type === 'Student';
  const sheetName = isStudent ? 'Students' : 'Staff';
  const idKey = isStudent ? 'StudentID' : 'StaffID';
  const historySheet = isStudent ? 'StudentDisableHistory' : 'StaffDisableHistory';
  const id = requiredText_(payload.recordId, type + ' ID', 60);
  const reason = requiredText_(payload.reason, 'Disable reason', 100);
  const explanation = requiredText_(payload.explanation, 'Detailed explanation', 500);
  return withDatabaseLock_(function () {
    const record = getRecords_(sheetName).find(function (row) { return row[idKey] === id && row.Status === 'Active'; });
    if (!record) throw new Error('Active ' + type.toLowerCase() + ' record was not found.');
    updateRecord_(sheetName, idKey, id, { Status: 'Disabled' });
    const history = {
      HistoryID: newId_()
    };
    history[idKey] = id;
    history.DisableDate = optionalDate_(payload.date) || today_();
    history.Reason = reason;
    history.Explanation = explanation;
    history.DisabledBy = actor.Name;
    history.Action = 'DISABLE';
    history.CreatedAt = now_();
    appendRecord_(historySheet, history);
    audit_(actor, 'DISABLE', sheetName, id, history, record);
    return history;
  });
}

function enableRecord_(actor, recordId, type) {
  const isStudent = type === 'Student';
  const sheetName = isStudent ? 'Students' : 'Staff';
  const idKey = isStudent ? 'StudentID' : 'StaffID';
  const historySheet = isStudent ? 'StudentDisableHistory' : 'StaffDisableHistory';
  return withDatabaseLock_(function () {
    const record = getRecords_(sheetName).find(function (row) { return row[idKey] === recordId && row.Status === 'Disabled'; });
    if (!record) throw new Error('Disabled ' + type.toLowerCase() + ' record was not found.');
    updateRecord_(sheetName, idKey, recordId, { Status: 'Active' });
    const history = { HistoryID: newId_() };
    history[idKey] = recordId;
    history.DisableDate = today_();
    history.Reason = 'Reactivated';
    history.Explanation = 'Record reactivated by an administrator.';
    history.DisabledBy = actor.Name;
    history.Action = 'ENABLE';
    history.CreatedAt = now_();
    appendRecord_(historySheet, history);
    audit_(actor, 'ENABLE', sheetName, recordId, history, record);
    return history;
  });
}

function createPayroll_(actor, payload) {
  const staffId = requiredText_(payload.staffId, 'Staff member', 50);
  const month = requiredText_(payload.salaryMonth, 'Salary month (YYYY-MM)', 7);
  if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) {
    throw new Error('Salary month must use YYYY-MM format.');
  }
  return withDatabaseLock_(function () {
    const staff = getRecords_('Staff').find(function (row) { return row.StaffID === staffId && row.Status === 'Active'; });
    if (!staff) throw new Error('Active staff member was not found.');
    if (getRecords_('Payroll').some(function (row) { return row.StaffID === staffId && row.SalaryMonth === month && row.PaymentStatus !== 'Cancelled'; })) {
      throw new Error('Payroll for this staff member and month already exists.');
    }
    const basic = money_(payload.basicSalary === '' || payload.basicSalary === undefined ? staff.BasicSalary : payload.basicSalary, 'Basic salary');
    const overtime = money_(payload.overtime || 0, 'Overtime');
    const bonus = money_(payload.bonus || 0, 'Bonus');
    const allowance = money_(payload.allowance || 0, 'Allowance');
    const advance = money_(payload.advance || 0, 'Advance');
    const deduction = money_(payload.deduction || 0, 'Deduction');
    const otherDeduction = money_(payload.otherDeduction || 0, 'Other deduction');
    const net = basic + overtime + bonus + allowance - advance - deduction - otherDeduction;
    if (net < 0) throw new Error('Deductions cannot exceed the payable salary.');
    const row = {
      PayrollID: newId_(), StaffID: staffId, StaffName: staff.Name,
      SessionID: payload.sessionId || getCurrentSessionId_(), SalaryMonth: month,
      BasicSalary: basic, WorkingDays: money_(payload.workingDays || 0, 'Working days'),
      PresentDays: money_(payload.presentDays || 0, 'Present days'),
      LeaveDays: money_(payload.leaveDays || 0, 'Leave days'),
      Overtime: overtime, Bonus: bonus, Allowance: allowance, Advance: advance,
      Deduction: deduction, OtherDeduction: otherDeduction, NetSalary: net,
      PaymentStatus: 'Due', PaymentDate: '', CreatedAt: now_()
    };
    appendRecord_('Payroll', row);
    audit_(actor, 'CREATE', 'Payroll', row.PayrollID, row);
    return row;
  });
}

function paySalary_(actor, payload) {
  const payrollId = requiredText_(payload.payrollId, 'Payroll record', 50);
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const payroll = getRecords_('Payroll').find(function (row) { return row.PayrollID === payrollId; });
    if (!payroll || payroll.PaymentStatus !== 'Due') throw new Error('Payroll is missing or has already been paid.');
    const salaryId = newId_();
    const receiptNo = nextNumber_('SAL');
    const transaction = recordFinancialTransaction_(actor, {
      type: 'SALARY_PAYMENT', referenceId: salaryId, referenceNumber: receiptNo,
      description: 'Salary - ' + payroll.StaffName + ' - ' + payroll.SalaryMonth,
      amount: Number(payroll.NetSalary), direction: 'out', sessionId: payroll.SessionID,
      staffId: payroll.StaffID, account: account, paymentMethod: method, date: payload.date
    });
    const payment = {
      SalaryPaymentID: salaryId, ReceiptNo: receiptNo, PayrollID: payrollId,
      StaffID: payroll.StaffID, SessionID: payroll.SessionID,
      Amount: Number(payroll.NetSalary), PaymentDate: transaction.Date,
      PaymentMethod: method, Reference: optionalText_(payload.reference, 100),
      TransactionID: transaction.TransactionID, PaidBy: actor.Name, Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('SalaryPayments', payment);
    appendRecord_('SalaryReceipts', { ReceiptID: newId_(), ReceiptNo: receiptNo, SalaryPaymentID: salaryId, CreatedAt: now_() });
    updateRecord_('Payroll', 'PayrollID', payrollId, { PaymentStatus: 'Paid', PaymentDate: transaction.Date });
    audit_(actor, 'PAYMENT', 'SalaryPayments', salaryId, payment);
    return payment;
  });
}

function listReport_(actor, payload) {
  const sessionId = String(payload.sessionId || '');
  const fromDate = optionalDate_(payload.fromDate);
  const toDate = optionalDate_(payload.toDate);
  const transactions = getRecords_('Transactions').filter(function (row) {
    return row.Status === 'Active' &&
      (!sessionId || row.SessionID === sessionId) &&
      (!fromDate || String(row.Date) >= fromDate) &&
      (!toDate || String(row.Date) <= toDate);
  }).sort(function (a, b) { return String(a.Date).localeCompare(String(b.Date)); });
  const students = getRecords_('Students').filter(function (row) {
    return (!sessionId || row.SessionID === sessionId) &&
      (!payload.courseId || row.CourseID === payload.courseId) &&
      (!payload.studentId || row.StudentID === payload.studentId);
  });
  const staff = getRecords_('Staff').filter(function (row) { return !payload.staffId || row.StaffID === payload.staffId; });
  const byType = {};
  transactions.forEach(function (row) {
    const key = String(row.TransactionType);
    if (!byType[key]) byType[key] = { count: 0, amount: 0 };
    byType[key].count++;
    byType[key].amount += Number(row.Amount || 0);
  });
  const cashBook = getRecords_('CashBook').filter(function (row) {
    return (!sessionId || row.SessionID === sessionId) &&
      (!fromDate || String(row.Date) >= fromDate) &&
      (!toDate || String(row.Date) <= toDate);
  });
  return {
    filters: { sessionId: sessionId, fromDate: fromDate, toDate: toDate },
    summary: {
      studentCount: students.length,
      activeStudents: students.filter(function (row) { return row.Status === 'Active'; }).length,
      staffCount: staff.length,
      transactionCount: transactions.length,
      totalIn: transactions.reduce(function (sum, row) { return sum + Number(row.Credit || 0); }, 0),
      totalOut: transactions.reduce(function (sum, row) { return sum + Number(row.Debit || 0); }, 0),
      net: transactions.reduce(function (sum, row) { return sum + Number(row.Credit || 0) - Number(row.Debit || 0); }, 0)
    },
    byType: byType,
    transactions: transactions,
    students: students,
    staff: staff,
    payrollDue: getRecords_('Payroll').filter(function (row) {
      return row.PaymentStatus === 'Due' && (!sessionId || row.SessionID === sessionId);
    }),
    cashBook: cashBook
  };
}

function getReceipt_(actor, receiptNo) {
  receiptNo = requiredText_(receiptNo, 'Receipt number', 60);
  let payment = getRecords_('FeePayments').find(function (row) { return row.ReceiptNo === receiptNo; });
  if (payment) {
    return { type: 'Fee Receipt', number: receiptNo, payment: payment, student: getRecords_('Students').find(function (row) { return row.StudentID === payment.StudentID; }), institution: institutionSettings_(settingsMap_()) };
  }
  const income = getRecords_('Income').find(function (row) { return row.ReceiptNo === receiptNo; });
  if (income) return { type: 'Income Receipt', number: receiptNo, payment: income, institution: institutionSettings_(settingsMap_()) };
  const expense = getRecords_('Expenses').find(function (row) { return row.VoucherNo === receiptNo; });
  if (expense) return { type: 'Expense Voucher', number: receiptNo, payment: expense, institution: institutionSettings_(settingsMap_()) };
  const salary = getRecords_('SalaryPayments').find(function (row) { return row.ReceiptNo === receiptNo; });
  if (salary) {
    const payroll = getRecords_('Payroll').find(function (row) { return row.PayrollID === salary.PayrollID; });
    const staff = getRecords_('Staff').find(function (row) { return row.StaffID === salary.StaffID; });
    return { type: 'Salary Receipt', number: receiptNo, payment: salary, payroll: payroll, staff: staff, institution: institutionSettings_(settingsMap_()) };
  }
  throw new Error('Receipt or voucher was not found.');
}

function exportBackup_(actor) {
  const spreadsheet = dbSpreadsheet_();
  const name = 'CIMS-Backup-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const copy = DriveApp.getFileById(spreadsheet.getId()).makeCopy(name, getDriveFolder_('Backups'));
  audit_(actor, 'BACKUP', 'Backups', copy.getId(), { FileName: copy.getName() });
  return { name: copy.getName(), url: copy.getUrl(), fileId: copy.getId() };
}

function listAccounts_() {
  const transactions = getRecords_('Transactions').filter(function (row) { return row.Status === 'Active'; });
  return getRecords_('Accounts').map(function (account) {
    const entries = transactions.filter(function (row) { return row.Account === account.AccountName; });
    const totalIn = entries.reduce(function (sum, row) { return sum + Number(row.Credit || 0); }, 0);
    const totalOut = entries.reduce(function (sum, row) { return sum + Number(row.Debit || 0); }, 0);
    return {
      AccountID: account.AccountID,
      AccountName: account.AccountName,
      AccountType: account.AccountType,
      OpeningBalance: Number(account.OpeningBalance || 0),
      TotalIn: totalIn,
      TotalOut: totalOut,
      Balance: Number(account.OpeningBalance || 0) + totalIn - totalOut,
      Status: account.Status
    };
  });
}

function createManagedUser_(actor, payload) {
  const email = requiredText_(payload.email, 'Email', 120).toLowerCase();
  const name = requiredText_(payload.name, 'Name', 100);
  const password = requiredText_(payload.password, 'Password', 200);
  const role = requiredText_(payload.role, 'Role', 40);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (password.length < 12) throw new Error('Password must contain at least 12 characters.');
  if (['Admin', 'Accountant', 'Staff'].indexOf(role) === -1) throw new Error('Choose Admin, Accountant, or Staff role.');
  return withDatabaseLock_(function () {
    if (getRecords_('Users').some(function (user) { return String(user.Email).toLowerCase() === email; })) {
      throw new Error('A user with this email already exists.');
    }
    const user = {
      UserID: newId_(), Name: name, Email: email, PasswordHash: hashPassword_(password),
      Role: role, Status: 'Active', CreatedAt: now_(), LastLogin: ''
    };
    appendRecord_('Users', user);
    audit_(actor, 'CREATE', 'Users', user.UserID, { Email: email, Name: name, Role: role });
    return { UserID: user.UserID, Name: user.Name, Email: user.Email, Role: user.Role, Status: user.Status };
  });
}

function uploadStaffPhoto_(actor, staffId, imageData, fileName, mimeType) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedTypes.indexOf(mimeType) === -1) throw new Error('Photo must be a JPG, PNG, or WebP image.');
  const bytes = Utilities.base64Decode(String(imageData || '').replace(/^data:[^;]+;base64,/, ''));
  if (!bytes.length || bytes.length > APP_CONFIG.maxUploadBytes || !isValidImageBytes_(bytes, mimeType)) {
    throw new Error('Select a valid JPG, PNG, or WebP image smaller than 3 MB.');
  }
  const staff = getRecords_('Staff').find(function (row) { return row.StaffID === staffId; });
  if (!staff) throw new Error('Staff record was not found.');
  const extension = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : '.webp';
  const safeName = String(fileName || 'staff-photo').replace(/[\\/:*?"<>|]/g, '_').replace(/\.[^.]*$/, '') + extension;
  const folder = getOrCreateFolder_(getDriveFolder_('Staff'), staff.StaffID + ' - ' + staff.Name);
  const file = folder.createFile(Utilities.newBlob(bytes, mimeType, safeName));
  updateRecord_('Staff', 'StaffID', staffId, { PhotoFileId: file.getId(), PhotoUrl: file.getUrl() });
  appendRecord_('StaffDocuments', {
    DocumentID: newId_(), StaffID: staffId, DocumentType: 'Photo', DocumentName: 'Staff Photo',
    FileID: file.getId(), FileURL: file.getUrl(), FileName: file.getName(), FileType: mimeType,
    UploadedAt: now_(), UploadedBy: actor.Name, Status: 'Active'
  });
  audit_(actor, 'UPLOAD', 'StaffDocuments', staffId, { FileID: file.getId(), FileName: file.getName() });
  return { fileId: file.getId(), fileUrl: file.getUrl() };
}

function uploadDocument_(actor, payload) {
  const isStudent = payload.ownerType === 'Student';
  if (!isStudent && payload.ownerType !== 'Staff') throw new Error('Choose Student or Staff document owner.');
  const ownerId = requiredText_(payload.ownerId, 'Record ID', 60);
  const ownerSheet = isStudent ? 'Students' : 'Staff';
  const ownerKey = isStudent ? 'StudentID' : 'StaffID';
  const docSheet = isStudent ? 'StudentDocuments' : 'StaffDocuments';
  const owner = getRecords_(ownerSheet).find(function (row) { return row[ownerKey] === ownerId; });
  if (!owner) throw new Error('The selected record was not found.');
  const documentType = requiredText_(payload.documentType, 'Document type', 80);
  const documentName = requiredText_(payload.documentName, 'Document name', 120);
  const fileName = requiredText_(payload.fileName, 'File name', 150).replace(/[\\/:*?"<>|]/g, '_');
  const mime = String(payload.mimeType || '');
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  if (allowed.indexOf(mime) === -1) throw new Error('Unsupported document type. Use PDF, JPG, PNG, WebP, DOCX, XLSX, or TXT.');
  const bytes = Utilities.base64Decode(String(payload.imageData || '').replace(/^data:[^;]+;base64,/, ''));
  if (!bytes.length || bytes.length > APP_CONFIG.maxUploadBytes) throw new Error('Document must be smaller than 3 MB.');
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') {
    if (!isValidImageBytes_(bytes, mime)) throw new Error('Uploaded file content does not match the selected image type.');
  }
  if (mime === 'application/pdf' && String.fromCharCode.apply(null, bytes.slice(0, 4).map(function (b) { return (b + 256) % 256; })) !== '%PDF') {
    throw new Error('Uploaded file content is not a valid PDF.');
  }
  const parent = getDriveFolder_(isStudent ? 'Student Documents' : 'Staff Documents');
  const folder = getOrCreateFolder_(parent, ownerId + ' - ' + owner[isStudent ? 'StudentName' : 'Name']);
  const file = folder.createFile(Utilities.newBlob(bytes, mime, fileName));
  const document = {
    DocumentID: newId_(), StudentID: isStudent ? ownerId : '', StaffID: isStudent ? '' : ownerId,
    DocumentType: documentType,
    DocumentName: documentName,
    FileID: file.getId(), FileURL: file.getUrl(), FileName: file.getName(), FileType: mime,
    UploadedAt: now_(), UploadedBy: actor.Name, Status: 'Active'
  };
  appendRecord_(docSheet, document);
  audit_(actor, 'UPLOAD', docSheet, document.DocumentID, document);
  return document;
}

function setDocumentStatus_(actor, documentId, ownerType) {
  const sheetName = ownerType === 'Student' ? 'StudentDocuments' : ownerType === 'Staff' ? 'StaffDocuments' : '';
  if (!sheetName) throw new Error('Choose Student or Staff document owner.');
  const document = getRecords_(sheetName).find(function (row) { return row.DocumentID === documentId && row.Status === 'Active'; });
  if (!document) throw new Error('Active document was not found.');
  updateRecord_(sheetName, 'DocumentID', documentId, { Status: 'Deleted' });
  audit_(actor, 'SOFT_DELETE', sheetName, documentId, { Status: 'Deleted' }, document);
  return true;
}

function saveBatch_(actor, payload) {
  const name = requiredText_(payload.batchName, 'Batch name', 80);
  const course = getRecords_('Courses').find(function (row) { return row.CourseID === payload.courseId && row.Status === 'Active'; });
  if (!course) throw new Error('Select an active course.');
  const sessionId = requiredText_(payload.sessionId, 'Session', 60);
  const session = getRecords_('Sessions').find(function (row) { return row.SessionID === sessionId && row.Status === 'Active'; });
  if (!session) throw new Error('Select an active session.');
  return withDatabaseLock_(function () {
    if (getRecords_('Batches').some(function (row) {
      return row.BatchName.toLowerCase() === name.toLowerCase() && row.CourseID === course.CourseID && row.SessionID === session.SessionID && row.Status === 'Active';
    })) throw new Error('This batch already exists for the selected course and session.');
    const batch = {
      BatchID: newId_(), BatchName: name, CourseID: course.CourseID, CourseName: course.CourseName,
      SessionID: session.SessionID, StartDate: optionalDate_(payload.startDate),
      EndDate: optionalDate_(payload.endDate), Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('Batches', batch);
    audit_(actor, 'CREATE', 'Batches', batch.BatchID, batch);
    return batch;
  });
}

function saveFeeMaster_(actor, payload) {
  const sessionId = requiredText_(payload.sessionId, 'Session', 60);
  const session = getRecords_('Sessions').find(function (row) { return row.SessionID === sessionId && row.Status === 'Active'; });
  const course = getRecords_('Courses').find(function (row) { return row.CourseID === payload.courseId && row.Status === 'Active'; });
  if (!session || !course) throw new Error('Select an active session and course.');
  const feeType = requiredText_(payload.feeType, 'Fee type', 80);
  const amount = money_(payload.amount, 'Fee amount');
  if (amount <= 0) throw new Error('Fee amount must be greater than zero.');
  const fee = {
    FeeID: newId_(), SessionID: sessionId, CourseID: course.CourseID, FeeType: feeType,
    Amount: amount, Frequency: optionalText_(payload.frequency, 40) || 'One-time',
    DueDate: optionalDate_(payload.dueDate), Status: 'Active', CreatedAt: now_()
  };
  appendRecord_('FeeMaster', fee);
  audit_(actor, 'CREATE', 'FeeMaster', fee.FeeID, fee);
  return fee;
}

function updateStudent_(actor, payload) {
  const studentId = requiredText_(payload.studentId, 'Student ID', 50);
  const student = getRecords_('Students').find(function (row) { return row.StudentID === studentId; });
  if (!student) throw new Error('Student record was not found.');
  const fields = {
    StudentName: requiredText_(payload.studentName, 'Student name', 100),
    FatherName: optionalText_(payload.fatherName, 100),
    MotherName: optionalText_(payload.motherName, 100),
    GuardianName: optionalText_(payload.guardianName, 100),
    DateOfBirth: optionalDate_(payload.dateOfBirth),
    Gender: optionalText_(payload.gender, 20),
    Mobile: requiredText_(payload.mobile, 'Mobile number', 20),
    AltMobile: optionalText_(payload.altMobile, 20),
    Email: optionalText_(payload.email, 120),
    Address: optionalText_(payload.address, 500),
    Village: optionalText_(payload.village, 100),
    PostOffice: optionalText_(payload.postOffice, 100),
    PoliceStation: optionalText_(payload.policeStation, 100),
    District: optionalText_(payload.district, 100),
    State: optionalText_(payload.state, 100),
    PIN: optionalText_(payload.pin, 12),
    IdentityNumber: optionalText_(payload.identityNumber, 40),
    Qualification: optionalText_(payload.qualification, 100),
    Occupation: optionalText_(payload.occupation, 100),
    Remarks: optionalText_(payload.remarks, 500),
    UpdatedAt: now_()
  };
  updateRecord_('Students', 'StudentID', studentId, fields);
  audit_(actor, 'UPDATE', 'Students', studentId, fields, student);
  return Object.assign({}, student, fields);
}

function studentProfile_(actor, studentId) {
  studentId = requiredText_(studentId, 'Student ID', 50);
  const student = getRecords_('Students').find(function (row) { return row.StudentID === studentId; });
  if (!student) throw new Error('Student record was not found.');
  const profile = {
    student: student,
    documents: getRecords_('StudentDocuments').filter(function (row) { return row.StudentID === studentId && row.Status === 'Active'; }),
    payments: getRecords_('FeePayments').filter(function (row) { return row.StudentID === studentId && row.Status === 'Active'; }),
    refunds: getRecords_('FeeRefunds').filter(function (row) { return row.StudentID === studentId && row.Status === 'Active'; }),
    concessions: getRecords_('Concessions').filter(function (row) { return row.StudentID === studentId && row.Status === 'Active'; }),
    disableHistory: getRecords_('StudentDisableHistory').filter(function (row) { return row.StudentID === studentId; })
  };
  if (actor.Role === 'Staff') {
    delete profile.payments;
    delete profile.refunds;
    delete profile.concessions;
    ['TotalFee', 'AdmissionFee', 'RegistrationFee', 'OtherFee', 'Concession', 'FinalFee'].forEach(function (key) { delete profile.student[key]; });
  }
  return profile;
}
