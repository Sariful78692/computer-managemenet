function setupDriveFolders() {
  const mainFolder = getOrCreateFolder_(DriveApp.getRootFolder(), APP_CONFIG.mainDriveFolder);
  const result = { mainFolderId: mainFolder.getId(), folders: {} };
  APP_CONFIG.driveFolders.forEach(function (name) {
    const folder = getOrCreateFolder_(mainFolder, name);
    result.folders[name] = folder.getId();
    saveSetting_('DriveFolder:' + name, folder.getId());
  });
  saveSetting_('DriveRootFolderId', mainFolder.getId());
  return result;
}

function uploadStudentPhoto(actor, studentId, imageData, fileName, mimeType) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedTypes.indexOf(mimeType) === -1) throw new Error('Photo must be a JPG, PNG, or WebP image.');
  const data = String(imageData || '').replace(/^data:[^;]+;base64,/, '');
  const bytes = Utilities.base64Decode(data);
  if (!bytes.length || bytes.length > APP_CONFIG.maxUploadBytes) throw new Error('Photo must be smaller than 3 MB.');
  if (!isValidImageBytes_(bytes, mimeType)) throw new Error('The uploaded file content does not match its image type.');
  const student = getRecords_('Students').find(function (row) { return row.StudentID === studentId; });
  if (!student) throw new Error('Student record was not found.');
  const extension = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : '.webp';
  const safeName = String(fileName || 'student-photo').replace(/[\\/:*?"<>|]/g, '_').replace(/\.[^.]*$/, '') + extension;
  const studentFolder = getOrCreateFolder_(getDriveFolder_('Students'), student.StudentID + ' - ' + student.StudentName);
  const file = studentFolder.createFile(Utilities.newBlob(bytes, mimeType, safeName));
  updateRecord_('Students', 'StudentID', studentId, { PhotoFileId: file.getId(), PhotoUrl: file.getUrl(), UpdatedAt: now_() });
  appendRecord_('StudentDocuments', {
    DocumentID: newId_(), StudentID: studentId, DocumentType: 'Photo', DocumentName: 'Student Photo',
    FileID: file.getId(), FileURL: file.getUrl(), FileName: file.getName(), FileType: mimeType,
    UploadedAt: now_(), UploadedBy: actor.Name, Status: 'Active'
  });
  audit_(actor, 'UPLOAD', 'StudentDocuments', studentId, { FileID: file.getId(), FileName: file.getName() });
  return { fileId: file.getId(), fileUrl: file.getUrl() };
}

function isValidImageBytes_(bytes, mimeType) {
  const byte = function (index) { return (bytes[index] + 256) % 256; };
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && byte(0) === 0xFF && byte(1) === 0xD8 && byte(2) === 0xFF;
  if (mimeType === 'image/png') return bytes.length >= 8 && [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every(function (value, index) { return byte(index) === value; });
  return mimeType === 'image/webp' && bytes.length >= 12 &&
    String.fromCharCode(byte(0), byte(1), byte(2), byte(3)) === 'RIFF' &&
    String.fromCharCode(byte(8), byte(9), byte(10), byte(11)) === 'WEBP';
}

function getDriveFolder_(name) {
  const folders = settingsMap_();
  let folderId = folders['DriveFolder:' + name];
  if (!folderId) {
    setupDriveFolders();
    folderId = settingsMap_()['DriveFolder:' + name];
  }
  if (!folderId) throw new Error('Drive folder is not configured. Run setupDriveFolders().');
  return DriveApp.getFolderById(folderId);
}

function getOrCreateFolder_(parent, name) {
  const iterator = parent.getFoldersByName(name);
  return iterator.hasNext() ? iterator.next() : parent.createFolder(name);
}

function saveSetting_(key, value) {
  const existing = getRecords_('Settings').find(function (row) { return row.Key === key; });
  if (existing) updateRecord_('Settings', 'Key', key, { Value: value, UpdatedAt: now_() });
  else appendRecord_('Settings', { Key: key, Value: value, UpdatedAt: now_() });
}
