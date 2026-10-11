function createAdminUser(email, password, name) {
  if (!email || !password) {
    const ui = SpreadsheetApp.getUi();
    const emailReply = ui.prompt('Create administrator', 'Administrator email:', ui.ButtonSet.OK_CANCEL);
    if (emailReply.getSelectedButton() !== ui.Button.OK) return 'Administrator creation cancelled.';
    const passwordReply = ui.prompt('Create administrator', 'Choose a strong password (at least 12 characters):', ui.ButtonSet.OK_CANCEL);
    if (passwordReply.getSelectedButton() !== ui.Button.OK) return 'Administrator creation cancelled.';
    email = emailReply.getResponseText();
    password = passwordReply.getResponseText();
    const nameReply = ui.prompt('Create administrator', 'Administrator name:', ui.ButtonSet.OK_CANCEL);
    if (nameReply.getSelectedButton() !== ui.Button.OK) return 'Administrator creation cancelled.';
    name = nameReply.getResponseText();
  }
  email = String(email).trim().toLowerCase();
  name = String(name || 'Administrator').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid administrator email.');
  if (String(password).length < 12) throw new Error('Administrator password must be at least 12 characters.');
  return withDatabaseLock_(function () {
    if (getRecords_('Users').some(function (user) { return String(user.Email).toLowerCase() === email; })) {
      throw new Error('A user with this email already exists.');
    }
    const user = {
      UserID: newId_(),
      Name: name,
      Email: email,
      PasswordHash: hashPassword_(String(password)),
      Role: 'Super Admin',
      Status: 'Active',
      CreatedAt: now_(),
      LastLogin: ''
    };
    appendRecord_('Users', user);
    audit_({ UserID: user.UserID, Name: user.Name }, 'CREATE', 'Users', user.UserID, { Email: email, Role: user.Role });
    return 'Administrator created. Sign in with the email and password you supplied.';
  });
}

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!email || !password) throw new Error('Email and password are required.');
  const user = getRecords_('Users').find(function (row) {
    return String(row.Email).toLowerCase() === email && row.Status === 'Active';
  });
  if (!user || !verifyPassword_(password, String(user.PasswordHash))) throw new Error('Email or password is incorrect.');
  const token = Utilities.getUuid() + Utilities.getUuid();
  const safeUser = { UserID: user.UserID, Name: user.Name, Email: user.Email, Role: user.Role };
  CacheService.getScriptCache().put('auth:' + sha256_(token), JSON.stringify(safeUser), APP_CONFIG.sessionCacheSeconds);
  updateRecord_('Users', 'UserID', user.UserID, { LastLogin: now_() });
  audit_(safeUser, 'LOGIN', 'Auth', user.UserID);
  return { token: token, user: safeUser };
}

function logout(token) {
  const actor = getActor_(token);
  CacheService.getScriptCache().remove('auth:' + sha256_(token));
  audit_(actor, 'LOGOUT', 'Auth', actor.UserID);
  return true;
}

function getActor_(token) {
  if (!token) throw new Error('Your session has expired. Please sign in again.');
  const value = CacheService.getScriptCache().get('auth:' + sha256_(String(token)));
  if (!value) throw new Error('Your session has expired. Please sign in again.');
  const actor = JSON.parse(value);
  const currentUser = getRecords_('Users').find(function (user) {
    return user.UserID === actor.UserID && user.Status === 'Active';
  });
  if (!currentUser) throw new Error('This account is disabled. Contact an administrator.');
  return actor;
}

function authorizeAction_(actor, action) {
  if (actor.Role === 'Super Admin' || actor.Role === 'Admin') return;
  const readActions = ['bootstrap', 'dashboard', 'students.list', 'courses.list', 'batches.list', 'sessions.list', 'sessions.current'];
  const accountantActions = readActions.concat([
    'transactions.list', 'students.save', 'students.photo', 'students.documents', 'staff.documents', 'documents.upload',
    'courses.save', 'batches.save', 'fees.master.list', 'fees.master.save', 'students.update', 'students.profile', 'sessions.save',
    'fees.collect', 'fees.refund', 'fees.concession', 'fees.concessions.list', 'fees.payments.list',
    'income.list', 'income.save', 'income.refund', 'expenses.list', 'expenses.save', 'expenses.refund',
    'staff.list', 'staff.save', 'staff.photo', 'staff.disable', 'staff.enable', 'payroll.list', 'payroll.create',
    'payroll.pay', 'reports.get', 'receipt.get', 'accounts.list', 'cashbook.list', 'categories.list'
  ]);
  const staffActions = readActions.concat(['students.save', 'students.photo', 'students.documents', 'students.profile', 'documents.upload']);
  if (actor.Role === 'Accountant' && accountantActions.indexOf(action) !== -1) return;
  if (actor.Role === 'Staff' && staffActions.indexOf(action) !== -1) return;
  throw new Error('Your role does not have permission to perform this action.');
}

function hashPassword_(password) {
  const salt = Utilities.getUuid() + Utilities.getUuid();
  let digest = salt + password;
  for (let index = 0; index < 10000; index++) digest = digestHex_(digest);
  return salt + '$' + digest;
}

function verifyPassword_(password, storedHash) {
  const separator = storedHash.indexOf('$');
  if (separator < 1) return false;
  const salt = storedHash.substring(0, separator);
  let digest = salt + password;
  for (let index = 0; index < 10000; index++) digest = digestHex_(digest);
  return digest === storedHash.substring(separator + 1);
}

function sha256_(value) {
  return digestHex_(value);
}

function digestHex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); })
    .join('');
}
