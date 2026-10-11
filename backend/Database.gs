function setupDatabase() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Open this Apps Script project from the database spreadsheet, then run setupDatabase().');
  }
  PropertiesService.getScriptProperties().setProperty('DATABASE_SPREADSHEET_ID', spreadsheet.getId());
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    Object.keys(APP_CONFIG.sheets).forEach(function (name) {
      let sheet = spreadsheet.getSheetByName(name);
      if (!sheet) sheet = spreadsheet.insertSheet(name);
      const headers = APP_CONFIG.sheets[name];
      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
      } else {
        const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
        const missing = headers.filter(function (header) { return existing.indexOf(header) === -1; });
        if (missing.length) {
          sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
        }
      }
    });
    seedDatabase_();
  } finally {
    lock.releaseLock();
  }
  return 'Database sheets are ready in ' + spreadsheet.getName() + '.';
}

function seedDatabase_() {
  const now = now_();
  const settings = getRecords_('Settings');
  if (!settings.some(function (row) { return row.Key === 'InstitutionName'; })) {
    appendRecord_('Settings', { Key: 'InstitutionName', Value: '', UpdatedAt: now });
    appendRecord_('Settings', { Key: 'InstitutionAddress', Value: '', UpdatedAt: now });
    appendRecord_('Settings', { Key: 'InstitutionPhone', Value: '', UpdatedAt: now });
    appendRecord_('Settings', { Key: 'InstitutionEmail', Value: '', UpdatedAt: now });
    appendRecord_('Settings', { Key: 'CurrentSessionID', Value: '', UpdatedAt: now });
  }
  const roleRows = getRecords_('Roles');
  [
    ['Super Admin', 'ALL'],
    ['Admin', 'ALL'],
    ['Accountant', 'dashboard,students,courses,sessions,fees,transactions'],
    ['Staff', 'dashboard,students,courses,sessions']
  ].forEach(function (role) {
    if (!roleRows.some(function (row) { return row.RoleName === role[0]; })) {
      appendRecord_('Roles', { RoleID: newId_(), RoleName: role[0], Permissions: role[1], Status: 'Active' });
    }
  });
  [['Cash', 'Cash'], ['Bank', 'Bank'], ['UPI', 'UPI'], ['Other', 'Other']].forEach(function (item) {
    if (!getRecords_('Accounts').some(function (row) { return row.AccountName === item[0]; })) {
      appendRecord_('Accounts', { AccountID: newId_(), AccountName: item[0], AccountType: item[1], OpeningBalance: 0, Status: 'Active', CreatedAt: now });
    }
  });
  [['Course Income'], ['Admission Income'], ['Certificate'], ['Registration'], ['Other']].forEach(function (item) {
    if (!getRecords_('IncomeCategories').some(function (row) { return row.CategoryName === item[0]; })) {
      appendRecord_('IncomeCategories', { CategoryID: newId_(), CategoryName: item[0], Status: 'Active' });
    }
  });
  [['Salary'], ['Rent'], ['Utilities'], ['Supplies'], ['Other']].forEach(function (item) {
    if (!getRecords_('ExpenseCategories').some(function (row) { return row.CategoryName === item[0]; })) {
      appendRecord_('ExpenseCategories', { CategoryID: newId_(), CategoryName: item[0], Status: 'Active' });
    }
  });
}

function dbSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('DATABASE_SPREADSHEET_ID');
  if (!id) throw new Error('Database is not configured. Run setupDatabase() first.');
  return SpreadsheetApp.openById(id);
}

function getRecords_(sheetName) {
  const sheet = dbSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Required database sheet is missing: ' + sheetName + '. Run setupDatabase() again.');
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(function (row) {
    return row.some(function (value) { return value !== '' && value !== null; });
  }).map(function (row) {
    const record = {};
    headers.forEach(function (header, index) {
      const value = row[index];
      record[header] = value instanceof Date ? Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd') : value;
    });
    return record;
  });
}

function appendRecord_(sheetName, record) {
  const sheet = dbSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Required database sheet is missing: ' + sheetName + '. Run setupDatabase() again.');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.appendRow(headers.map(function (header) {
    return record[header] === undefined || record[header] === null ? '' : record[header];
  }));
}

function updateRecord_(sheetName, key, id, updates) {
  const sheet = dbSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Required database sheet is missing: ' + sheetName);
  const values = sheet.getDataRange().getValues();
  if (!values.length) return false;
  const headers = values[0].map(String);
  const keyIndex = headers.indexOf(key);
  if (keyIndex < 0) throw new Error('Invalid key column for ' + sheetName + ': ' + key);
  const updateColumns = Object.keys(updates).map(function (name) {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error('Invalid column for ' + sheetName + ': ' + name);
    return { name: name, index: index };
  });
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    if (String(values[rowIndex][keyIndex]) === String(id)) {
      updateColumns.forEach(function (column) {
        sheet.getRange(rowIndex + 1, column.index + 1).setValue(updates[column.name]);
      });
      return true;
    }
  }
  return false;
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 16).toUpperCase();
}

function now_() {
  return new Date().toISOString();
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function withDatabaseLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function nextNumber_(prefix) {
  const year = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy');
  const key = prefix + '-' + year;
  const rows = getRecords_('NumberSeries');
  const existing = rows.find(function (row) { return row.SeriesKey === key; });
  const next = existing ? Number(existing.LastNumber) + 1 : 1;
  if (existing) {
    updateRecord_('NumberSeries', 'SeriesKey', key, { LastNumber: next });
  } else {
    appendRecord_('NumberSeries', { SeriesKey: key, Prefix: prefix, Year: year, LastNumber: next });
  }
  return prefix + '-' + year + '-' + String(next).padStart(4, '0');
}

function settingsMap_() {
  const result = {};
  getRecords_('Settings').forEach(function (row) { result[row.Key] = row.Value; });
  return result;
}

function audit_(actor, action, moduleName, recordId, newData, oldData) {
  appendRecord_('AuditLogs', {
    AuditID: newId_(),
    UserID: actor.UserID,
    UserName: actor.Name,
    Action: action,
    Module: moduleName,
    RecordID: recordId || '',
    OldData: oldData ? JSON.stringify(oldData) : '',
    NewData: newData ? JSON.stringify(newData) : '',
    CreatedAt: now_()
  });
}
