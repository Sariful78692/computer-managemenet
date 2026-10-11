function doGet() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    service: APP_CONFIG.title + ' API',
    message: 'Send a JSON POST request with an action and payload.'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(event) {
  try {
    if (!event || !event.postData || !event.postData.contents) throw new Error('Request body must contain JSON.');
    const request = JSON.parse(event.postData.contents);
    if (!request || typeof request.action !== 'string') throw new Error('Request must include an action.');
    return ContentService.createTextOutput(JSON.stringify(api(request.token || '', request.action, request.payload || {})))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    console.error('API request could not be parsed: ' + error.stack);
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: error.message || 'Invalid API request.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function api(token, action, payload) {
  try {
    payload = payload || {};
    if (action === 'login') return { ok: true, data: login(payload.email, payload.password) };
    if (action === 'logout') return { ok: true, data: logout(token) };
    const actor = getActor_(token);
    authorizeAction_(actor, action);
    return { ok: true, data: handleApiAction_(actor, action, payload) };
  } catch (error) {
    console.error('API action failed (' + action + '): ' + error.stack);
    return { ok: false, error: error.message || 'The request could not be completed.' };
  }
}

function handleApiAction_(actor, action, payload) {
  switch (action) {
    case 'bootstrap':
      const settings = settingsMap_();
      return {
        user: actor,
        settings: institutionSettings_(settings),
        sessions: getRecords_('Sessions'),
        courses: getRecords_('Courses').filter(function (row) { return row.Status === 'Active'; }),
        currentSessionId: settings.CurrentSessionID || ''
      };
    case 'dashboard': return dashboardData_(payload.sessionId || '', actor.Role !== 'Staff');
    case 'students.list':
      const studentRows = getRecords_('Students').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; });
      return actor.Role === 'Staff' ? studentRows.map(function (row) {
        const safe = Object.assign({}, row);
        ['TotalFee', 'AdmissionFee', 'RegistrationFee', 'OtherFee', 'Concession', 'FinalFee'].forEach(function (key) { delete safe[key]; });
        return safe;
      }) : studentRows;
    case 'courses.list': return getRecords_('Courses');
    case 'courses.save': return saveCourse_(actor, payload);
    case 'batches.list': return getRecords_('Batches').filter(function (row) {
      return (!payload.sessionId || row.SessionID === payload.sessionId) && (!payload.courseId || row.CourseID === payload.courseId);
    });
    case 'batches.save': return saveBatch_(actor, payload);
    case 'fees.master.list': return getRecords_('FeeMaster').filter(function (row) {
      return (!payload.sessionId || row.SessionID === payload.sessionId) && (!payload.courseId || row.CourseID === payload.courseId);
    });
    case 'fees.master.save': return saveFeeMaster_(actor, payload);
    case 'sessions.list': return getRecords_('Sessions');
    case 'sessions.save': return saveSession_(actor, payload);
    case 'sessions.current': return setCurrentSession_(actor, payload.sessionId);
    case 'students.save': return saveStudent_(actor, payload);
    case 'students.update': return updateStudent_(actor, payload);
    case 'students.profile': return studentProfile_(actor, payload.studentId);
    case 'students.photo': return uploadStudentPhoto(actor, payload.studentId, payload.imageData, payload.fileName, payload.mimeType);
    case 'students.documents': return getRecords_('StudentDocuments').filter(function (row) { return row.StudentID === payload.studentId; });
    case 'staff.photo': return uploadStaffPhoto_(actor, payload.staffId, payload.imageData, payload.fileName, payload.mimeType);
    case 'staff.documents': return getRecords_('StaffDocuments').filter(function (row) { return row.StaffID === payload.staffId; });
    case 'documents.upload': return uploadDocument_(actor, payload);
    case 'documents.delete': return setDocumentStatus_(actor, payload.documentId, payload.ownerType);
    case 'fees.collect': return collectFee_(actor, payload);
    case 'fees.refund': return refundFee_(actor, payload);
    case 'fees.concession': return saveConcession_(actor, payload);
    case 'fees.concessions.list': return getRecords_('Concessions').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; });
    case 'fees.payments.list': return getRecords_('FeePayments').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; });
    case 'income.list': return getRecords_('Income').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; });
    case 'income.save': return saveIncome_(actor, payload);
    case 'income.refund': return refundIncome_(actor, payload);
    case 'expenses.list': return getRecords_('Expenses').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; });
    case 'expenses.save': return saveExpense_(actor, payload);
    case 'expenses.refund': return refundExpense_(actor, payload);
    case 'staff.list': return getRecords_('Staff');
    case 'staff.save': return saveStaff_(actor, payload);
    case 'staff.disable': return disableRecord_(actor, payload, 'Staff');
    case 'staff.enable': return enableRecord_(actor, payload.recordId, 'Staff');
    case 'students.disable': return disableRecord_(actor, payload, 'Student');
    case 'students.enable': return enableRecord_(actor, payload.recordId, 'Student');
    case 'payroll.list': return getRecords_('Payroll').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; });
    case 'payroll.create': return createPayroll_(actor, payload);
    case 'payroll.pay': return paySalary_(actor, payload);
    case 'reports.get': return listReport_(actor, payload);
    case 'receipt.get': return getReceipt_(actor, payload.receiptNo);
    case 'accounts.list': return listAccounts_();
    case 'cashbook.list': return getRecords_('CashBook').filter(function (row) { return !payload.sessionId || row.SessionID === payload.sessionId; }).slice(-500).reverse();
    case 'backup.create': return exportBackup_(actor);
    case 'categories.list': return { income: getRecords_('IncomeCategories'), expenses: getRecords_('ExpenseCategories') };
    case 'users.list': return getRecords_('Users').map(function (row) {
      return { UserID: row.UserID, Name: row.Name, Email: row.Email, Role: row.Role, Status: row.Status, CreatedAt: row.CreatedAt };
    });
    case 'users.create': return createManagedUser_(actor, payload);
    case 'transactions.list': return getRecords_('Transactions').slice(-300).reverse();
    case 'settings.get': return institutionSettings_(settingsMap_());
    case 'settings.save': return saveInstitutionSettings_(actor, payload);
    default: throw new Error('Unknown operation: ' + action);
  }
}

function dashboardData_(sessionId, canViewFinance) {
  const students = getRecords_('Students').filter(function (row) { return !sessionId || row.SessionID === sessionId; });
  const transactions = getRecords_('Transactions').filter(function (row) {
    return row.Status === 'Active' && (!sessionId || row.SessionID === sessionId);
  });
  const today = today_();
  const inTypes = ['FEE_PAYMENT', 'ADMISSION_PAYMENT', 'INCOME', 'EXPENSE_REFUND'];
  const outTypes = ['FEE_REFUND', 'INCOME_REFUND', 'EXPENSE', 'SALARY_PAYMENT'];
  const paid = canViewFinance ? transactions.filter(function (row) { return inTypes.indexOf(row.TransactionType) !== -1; }) : [];
  const paidOut = canViewFinance ? transactions.filter(function (row) { return outTypes.indexOf(row.TransactionType) !== -1; }) : [];
  const receivedToday = paid.filter(function (row) { return String(row.Date).indexOf(today) === 0; })
    .reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0);
  const studentDue = students.reduce(function (sum, row) { return sum + Math.max(0, Number(row.FinalFee || 0) - studentNetPaid_(row.StudentID)); }, 0);
  return {
    totalStudents: students.length,
    activeStudents: students.filter(function (row) { return row.Status === 'Active'; }).length,
    disabledStudents: students.filter(function (row) { return row.Status === 'Disabled'; }).length,
    collectedToday: canViewFinance ? receivedToday : null,
    totalReceived: canViewFinance ? paid.reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0) : null,
    totalPaidOut: canViewFinance ? paidOut.reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0) : null,
    totalDue: canViewFinance ? studentDue : null,
    financialsVisible: canViewFinance,
    netBalance: canViewFinance ? Number(settingsMap_().OpeningBalance || 0) +
      paid.reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0) -
      paidOut.reduce(function (sum, row) { return sum + Number(row.Amount || 0); }, 0) : null
  };
}

function institutionSettings_(settings) {
  return {
    InstitutionName: settings.InstitutionName || '',
    InstitutionAddress: settings.InstitutionAddress || '',
    InstitutionPhone: settings.InstitutionPhone || '',
    InstitutionEmail: settings.InstitutionEmail || ''
  };
}

function studentNetPaid_(studentId) {
  return getRecords_('Transactions').filter(function (row) {
    return row.StudentID === studentId && ['FEE_PAYMENT', 'ADMISSION_PAYMENT', 'FEE_REFUND'].indexOf(row.TransactionType) !== -1 && row.Status === 'Active';
  }).reduce(function (sum, row) {
    return sum + (row.TransactionType === 'FEE_REFUND' ? -Number(row.Amount || 0) : Number(row.Amount || 0));
  }, 0);
}

function saveSession_(actor, payload) {
  const name = requiredText_(payload.sessionName, 'Session name', 30);
  return withDatabaseLock_(function () {
    const existing = getRecords_('Sessions').find(function (row) { return row.SessionName.toLowerCase() === name.toLowerCase(); });
    if (existing) throw new Error('A session with this name already exists.');
    const session = {
      SessionID: newId_(), SessionName: name, StartDate: optionalDate_(payload.startDate),
      EndDate: optionalDate_(payload.endDate), Status: 'Active', IsCurrent: 'No', CreatedAt: now_()
    };
    appendRecord_('Sessions', session);
    audit_(actor, 'CREATE', 'Sessions', session.SessionID, session);
    return session;
  });
}

function setCurrentSession_(actor, sessionId) {
  const session = getRecords_('Sessions').find(function (row) { return row.SessionID === sessionId && row.Status === 'Active'; });
  if (!session) throw new Error('Choose an active session.');
  withDatabaseLock_(function () {
    getRecords_('Sessions').forEach(function (row) {
      updateRecord_('Sessions', 'SessionID', row.SessionID, { IsCurrent: row.SessionID === sessionId ? 'Yes' : 'No' });
    });
    saveSetting_('CurrentSessionID', sessionId);
  });
  audit_(actor, 'SET_CURRENT', 'Sessions', sessionId, { SessionName: session.SessionName });
  return session;
}

function saveCourse_(actor, payload) {
  const courseName = requiredText_(payload.courseName, 'Course name', 80);
  return withDatabaseLock_(function () {
    if (getRecords_('Courses').some(function (row) { return row.CourseName.toLowerCase() === courseName.toLowerCase() && row.Status === 'Active'; })) {
      throw new Error('An active course with this name already exists.');
    }
    const course = {
      CourseID: newId_(), CourseName: courseName, Duration: requiredText_(payload.duration, 'Duration', 40),
      Description: optionalText_(payload.description, 300), Status: 'Active', CreatedAt: now_()
    };
    appendRecord_('Courses', course);
    audit_(actor, 'CREATE', 'Courses', course.CourseID, course);
    return course;
  });
}

function saveStudent_(actor, payload) {
  const name = requiredText_(payload.studentName, 'Student name', 100);
  const mobile = requiredText_(payload.mobile, 'Mobile number', 20);
  const sessionId = requiredText_(payload.sessionId, 'Session', 60);
  const session = getRecords_('Sessions').find(function (row) { return row.SessionID === sessionId && row.Status === 'Active'; });
  if (!session) throw new Error('Select an active session.');
  const course = getRecords_('Courses').find(function (row) { return row.CourseID === payload.courseId && row.Status === 'Active'; });
  if (!course) throw new Error('Select an active course.');
  const totalFee = money_(payload.totalFee || 0, 'Total course fee');
  const admissionFee = money_(payload.admissionFee || 0, 'Admission fee');
  const registrationFee = money_(payload.registrationFee || 0, 'Registration fee');
  const otherFee = money_(payload.otherFee || 0, 'Other fee');
  const concession = money_(payload.concession || 0, 'Concession');
  const finalFee = Math.max(0, totalFee + admissionFee + registrationFee + otherFee - concession);
  return withDatabaseLock_(function () {
    const student = {
      StudentID: nextNumber_('STU'), AdmissionNo: nextNumber_('ADM'), SessionID: session.SessionID,
      SessionName: session.SessionName, PhotoFileId: '', PhotoUrl: '', StudentName: name,
      FatherName: optionalText_(payload.fatherName, 100), MotherName: optionalText_(payload.motherName, 100),
      GuardianName: optionalText_(payload.guardianName, 100), DateOfBirth: optionalDate_(payload.dateOfBirth),
      Gender: optionalText_(payload.gender, 20), Mobile: mobile, AltMobile: optionalText_(payload.altMobile, 20),
      Email: optionalText_(payload.email, 120), Address: optionalText_(payload.address, 500),
      Village: optionalText_(payload.village, 100), PostOffice: optionalText_(payload.postOffice, 100),
      PoliceStation: optionalText_(payload.policeStation, 100), District: optionalText_(payload.district, 100),
      State: optionalText_(payload.state, 100), PIN: optionalText_(payload.pin, 12),
      IdentityNumber: optionalText_(payload.identityNumber, 40), Qualification: optionalText_(payload.qualification, 100),
      Occupation: optionalText_(payload.occupation, 100), AdmissionDate: optionalDate_(payload.admissionDate) || today_(),
      CourseID: course.CourseID, CourseName: course.CourseName, BatchID: '', BatchName: '',
      CourseDuration: course.Duration, TotalFee: totalFee, AdmissionFee: admissionFee,
      RegistrationFee: registrationFee, OtherFee: otherFee, Concession: concession, FinalFee: finalFee,
      InstallmentType: optionalText_(payload.installmentType, 30), Remarks: optionalText_(payload.remarks, 500),
      Status: 'Active', CreatedAt: now_(), UpdatedAt: now_()
    };
    appendRecord_('Students', student);
    appendRecord_('StudentFees', {
      StudentFeeID: newId_(), StudentID: student.StudentID, SessionID: session.SessionID,
      FeeType: 'Course Fee', Amount: finalFee, PaidAmount: 0, ConcessionAmount: concession,
      RefundAmount: 0, Balance: finalFee, Status: 'Active', CreatedAt: now_()
    });
    audit_(actor, 'CREATE', 'Students', student.StudentID, student);
    return student;
  });
}

function collectFee_(actor, payload) {
  const studentId = requiredText_(payload.studentId, 'Student', 40);
  const student = getRecords_('Students').find(function (row) { return row.StudentID === studentId && row.Status === 'Active'; });
  if (!student) throw new Error('Active student was not found.');
  const amount = money_(payload.amount, 'Payment amount');
  if (amount <= 0) throw new Error('Payment amount must be greater than zero.');
  const method = paymentMethod_(payload.paymentMethod);
  const account = accountForMethod_(method);
  return withDatabaseLock_(function () {
    const feeRecord = getRecords_('StudentFees').find(function (row) {
      return row.StudentID === student.StudentID && row.SessionID === student.SessionID && row.FeeType !== 'Concession' && row.Status !== 'Cancelled';
    });
    if (feeRecord && amount > Number(feeRecord.Balance || 0)) {
      throw new Error('Payment exceeds the student’s outstanding fee balance of ' + Number(feeRecord.Balance || 0) + '.');
    }
    const paymentId = newId_();
    const transactionId = newId_();
    const receiptNo = nextNumber_('FEE');
    const transaction = {
      TransactionID: transactionId, Date: optionalDate_(payload.paymentDate) || today_(),
      SessionID: student.SessionID, TransactionType: 'FEE_PAYMENT', ReferenceID: paymentId,
      ReferenceNumber: receiptNo, Description: 'Fee payment - ' + student.StudentName,
      Account: account, PaymentMethod: method, Debit: 0, Credit: amount, Amount: amount,
      StudentID: student.StudentID, StaffID: '', CreatedBy: actor.Name, CreatedAt: now_(), Status: 'Active'
    };
    appendRecord_('FeePayments', {
      PaymentID: paymentId, ReceiptNo: receiptNo, StudentID: student.StudentID,
      SessionID: student.SessionID, CourseName: student.CourseName,
      FeeType: optionalText_(payload.feeType, 60) || 'Course Fee', Amount: amount,
      PaymentDate: transaction.Date, PaymentMethod: method,
      TransactionReference: optionalText_(payload.reference, 100), Remarks: optionalText_(payload.remarks, 300),
      CollectedBy: actor.Name, TransactionID: transactionId, Status: 'Active', CreatedAt: now_()
    });
    appendRecord_('FeeReceipts', { ReceiptID: newId_(), ReceiptNo: receiptNo, PaymentID: paymentId, StudentID: student.StudentID, SessionID: student.SessionID, CreatedAt: now_() });
    appendTransaction_(transaction);
    refreshStudentFee_(student.StudentID, student.SessionID);
    audit_(actor, 'PAYMENT', 'FeePayments', paymentId, { Amount: amount, ReceiptNo: receiptNo, StudentID: student.StudentID });
    return { paymentId: paymentId, receiptNo: receiptNo, transactionId: transactionId, amount: amount, studentName: student.StudentName };
  });
}

function appendTransaction_(transaction) {
  if (getRecords_('Transactions').some(function (row) { return row.TransactionID === transaction.TransactionID; })) {
    throw new Error('Duplicate transaction ID; no additional transaction was recorded.');
  }
  appendRecord_('Transactions', transaction);
  const account = getRecords_('Accounts').find(function (row) { return row.AccountName === transaction.Account; });
  const balance = getRecords_('Transactions').filter(function (row) {
    return row.Account === transaction.Account && row.Status === 'Active';
  }).reduce(function (sum, row) {
    return sum + Number(row.Credit || 0) - Number(row.Debit || 0);
  }, Number(account ? account.OpeningBalance : 0));
  appendRecord_('CashBook', {
    EntryID: newId_(), Date: transaction.Date, TransactionID: transaction.TransactionID,
    Particular: transaction.Description, Reference: transaction.ReferenceNumber,
    CashIn: transaction.Credit, CashOut: transaction.Debit, Balance: balance,
    Account: transaction.Account, SessionID: transaction.SessionID
  });
}

function saveInstitutionSettings_(actor, payload) {
  const allowed = {
    InstitutionName: requiredText_(payload.institutionName, 'Institution name', 120),
    InstitutionAddress: optionalText_(payload.address, 300),
    InstitutionPhone: optionalText_(payload.phone, 30),
    InstitutionEmail: optionalText_(payload.email, 120)
  };
  withDatabaseLock_(function () {
    Object.keys(allowed).forEach(function (key) { saveSetting_(key, allowed[key]); });
  });
  audit_(actor, 'UPDATE', 'Settings', 'institution', allowed);
  return settingsMap_();
}

function accountForMethod_(method) {
  const accountName = method === 'Cash' ? 'Cash' : method === 'Bank' ? 'Bank' : method === 'UPI' ? 'UPI' : 'Other';
  const account = getRecords_('Accounts').find(function (row) { return row.AccountName === accountName && row.Status === 'Active'; });
  if (!account) throw new Error('No active account is configured for ' + method + '.');
  return account.AccountName;
}

function paymentMethod_(value) {
  const method = String(value || 'Cash');
  if (APP_CONFIG.paymentMethods.indexOf(method) === -1) throw new Error('Choose a valid payment method.');
  return method;
}

function requiredText_(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(label + ' is required.');
  if (text.length > maxLength) throw new Error(label + ' must be ' + maxLength + ' characters or fewer.');
  return text;
}

function optionalText_(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw new Error('Text must be ' + maxLength + ' characters or fewer.');
  return text;
}

function optionalDate_(value) {
  if (!value) return '';
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || isNaN(new Date(text + 'T00:00:00Z').getTime())) {
    throw new Error('Enter a valid date.');
  }
  return text;
}

function money_(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000 || Math.round(amount * 100) !== amount * 100) {
    throw new Error(label + ' must be a non-negative amount with at most two decimal places.');
  }
  return amount;
}
