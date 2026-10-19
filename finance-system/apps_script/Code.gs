/**
 * Satamoni Financial Management System - Apps Script (اختياري)
 * ------------------------------------------------------------------
 * النظام يعمل كاملًا بالمعادلات دون هذا السكربت. السكربت يضيف فقط:
 *   1) سجل مراجعة آلي لتعديلات أوراق المستندات (Audit_Log)
 *   2) حماية الخلايا ذات المعادلات وقفل صفوف المستندات (مرحل)
 *   3) إقفال فترة بلقطة قيم مع رفض الإقفال عند وجود بنود حرجة
 *   4) نسخة احتياطية بتاريخ ووقت
 * التثبيت: انظر docs/08_AppsScript_Install.md
 * ملاحظة أمنية: Google Sheets ليس نظام صلاحيات مالي غير قابل للتلاعب؛ مالك الملف/المحرر الكامل
 * يستطيع تجاوز هذه الحمايات. السكربت يقلل الأخطاء العارضة ويوثّق التعديلات فقط.
 */

var CFG = {
  AUDIT_SHEET: 'Audit_Log',
  USERS_SHEET: 'Users',
  PERIOD_SHEET: 'Period_Close',
  HEADER_ROW: 4,
  FIRST_ROW: 5,
  STATUS_POSTED: 'مرحل',
  // الأوراق المصدرية: يُسجَّل تعديلها ويُقفل الصف عند الترحيل
  SOURCE_SHEETS: ['Sales_Daily', 'Platform_Settlements', 'Daily_Recon', 'Cash_Vouchers', 'Cash_Close', 'Expenses',
                  'Supplier_Invoices', 'Supplier_Payments', 'Manual_JE'],
  // أوراق مدخلات أخرى تُسجَّل تعديلاتها
  MASTER_SHEETS: ['COA', 'Locations', 'Treasuries', 'Payment_Methods', 'Cost_Centers', 'Suppliers', 'Customers', 'Employees',
                  'Users', 'Settings', 'Tax_Settings', 'Posting_Rules', 'Unit_Conversions', 'Items', 'Period_Close', 'Close_Confirm'],
  // أدوار تملك حق تعديل الصفوف المرحلة/إقفال الفترة (يُقرأ بريدها من ورقة Users)
  PRIVILEGED_ROLES: ['المدير المالي', 'الإدارة العليا'],
  // أدوار تعدّل خلايا الإدخال في الأوراق المصدرية
  EDITOR_ROLES: ['المدير المالي', 'المحاسب', 'مدير فرع', 'أمين صندوق', 'أمين مخزن', 'مشرف مشتريات', 'مدير إنتاج'],
  BACKUP_FOLDER_ID: '' // ضع معرّف مجلد Drive للنسخ الاحتياطية (اختياري)
};

/* ============================ القائمة ============================ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ستاموني')
    .addItem('1) تفعيل سجل المراجعة (مرة واحدة)', 'installTriggers')
    .addItem('2) تطبيق حماية الصيغ والصفوف المرحلة', 'applyProtections')
    .addItem('3) فحص جاهزية الإقفال', 'checkClosingReadiness')
    .addItem('4) إقفال الفترة (لقطة قيم)', 'closePeriod')
    .addItem('5) نسخة احتياطية الآن', 'backupNow')
    .addToUi();
}

/* ====================== سجل المراجعة (Audit Log) ====================== */
function installTriggers() {
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'auditOnEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('auditOnEdit').forSpreadsheet(ss).onEdit().create();
  SpreadsheetApp.getUi().alert('تم تفعيل سجل المراجعة. سيُسجَّل كل تعديل في ورقة ' + CFG.AUDIT_SHEET + '.');
}

/** يُستدعى من مشغّل onEdit القابل للتثبيت (يعطي بريد المستخدم). */
function auditOnEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var name = sh.getName();
    if (name === CFG.AUDIT_SHEET) return;
    var tracked = CFG.SOURCE_SHEETS.concat(CFG.MASTER_SHEETS);
    if (tracked.indexOf(name) < 0) return;
    var row = e.range.getRow();
    if (name !== 'Settings' && name !== 'Tax_Settings' && row < CFG.FIRST_ROW) return;
    var user = (e.user && e.user.getEmail()) || Session.getActiveUser().getEmail() || 'غير معروف';

    // منع تعديل صف مرحل لغير المخوّلين (إرجاع القيمة السابقة)
    var action = 'تعديل';
    if (CFG.SOURCE_SHEETS.indexOf(name) >= 0 && row >= CFG.FIRST_ROW) {
      var statusCol = findHeaderCol_(sh, 'حالة المستند');
      if (statusCol > 0) {
        var cur = sh.getRange(row, statusCol).getValue();
        var wasPosted = (e.range.getColumn() === statusCol && e.oldValue === CFG.STATUS_POSTED) ||
                        (e.range.getColumn() !== statusCol && cur === CFG.STATUS_POSTED);
        if (wasPosted && !isPrivileged_(user)) {
          if (e.range.getNumRows() === 1 && e.range.getNumColumns() === 1) {
            if (e.oldValue === undefined) e.range.clearContent(); else e.range.setValue(e.oldValue);
          }
          SpreadsheetApp.getActive().toast('مستند مرحل لا يُعدَّل. اعكسه بمستند تصحيح (المدير المالي).', 'ممنوع', 8);
          action = 'محاولة تعديل مرفوضة (مستند مرحل)';
        }
        if (e.range.getColumn() === statusCol) {
          if (e.value === CFG.STATUS_POSTED) action = 'ترحيل';
          else if (e.value === 'معتمد') action = 'اعتماد';
          else if (e.value === 'معكوس') action = 'عكس';
          else if (e.value === 'ملغى') action = 'إلغاء';
        }
      }
    }
    var docCol = findHeaderCol_(sh, 'رقم');
    var ref = sh.getName() + '!' + e.range.getA1Notation();
    var audit = SpreadsheetApp.getActive().getSheetByName(CFG.AUDIT_SHEET);
    if (!audit) return;
    var last = Math.max(audit.getLastRow(), CFG.HEADER_ROW) + 1;
    // الأعمدة: التاريخ، المستخدم، الورقة، المرجع، الإجراء، القيمة السابقة، الجديدة، السبب، المعتمد
    audit.getRange(last, 1, 1, 9).setValues([[new Date(), '', name, ref, action,
      e.oldValue === undefined ? '' : String(e.oldValue), e.value === undefined ? '' : String(e.value), '', '']]);
    // اسم المستخدم لا يطابق قائمة Users (قائمة منسدلة)، لذا يُكتب البريد في عمود السبب
    audit.getRange(last, 8).setValue('بريد المنفذ: ' + user);
  } catch (err) {
    console.error(err);
  }
}

/* ========================= الحماية ========================= */
function applyProtections() {
  var ss = SpreadsheetApp.getActive();
  var editors = emailsByRole_(CFG.EDITOR_ROLES);
  var priv = emailsByRole_(CFG.PRIVILEGED_ROLES);
  var me = Session.getEffectiveUser().getEmail();
  var count = 0;
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    // أزل حمايات السكربت السابقة
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) {
      if (p.getDescription() === 'ستاموني-آلي') p.remove();
    });
    var p = sh.protect().setDescription('ستاموني-آلي');
    var unprot = inputRanges_(sh);
    if (unprot.length) p.setUnprotectedRanges(unprot);
    p.removeEditors(p.getEditors());
    var allowed = priv.slice();
    if (CFG.SOURCE_SHEETS.indexOf(name) >= 0 || name === 'Close_Confirm') allowed = allowed.concat(editors);
    allowed.push(me);
    allowed = dedupe_(allowed).filter(function (x) { return x; });
    if (allowed.length) p.addEditors(allowed);
    if (p.canDomainEdit()) p.setDomainEdit(false);
    count++;
  });
  lockPostedRows();
  SpreadsheetApp.getUi().alert('تم تطبيق الحماية على ' + count + ' ورقة وقفل الصفوف المرحلة.\n' +
    'تذكير: مالك الملف يستطيع تجاوز الحماية؛ استخدم سجل الإصدارات والنسخ الاحتياطية.');
}

/** يقفل صفوف المستندات (مرحل) بحيث يعدّلها المخوّلون فقط. شغّله بعد كل دفعة ترحيل. */
function lockPostedRows() {
  var ss = SpreadsheetApp.getActive();
  var priv = emailsByRole_(CFG.PRIVILEGED_ROLES);
  var me = Session.getEffectiveUser().getEmail();
  CFG.SOURCE_SHEETS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var statusCol = findHeaderCol_(sh, 'حالة المستند');
    if (statusCol < 1) return;
    var last = sh.getLastRow();
    if (last < CFG.FIRST_ROW) return;
    var vals = sh.getRange(CFG.FIRST_ROW, statusCol, last - CFG.FIRST_ROW + 1, 1).getValues();
    var existing = {};
    sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
      if (p.getDescription().indexOf('مرحل-') === 0) existing[p.getRange().getRow()] = true;
    });
    for (var i = 0; i < vals.length; i++) {
      var r = CFG.FIRST_ROW + i;
      if (vals[i][0] === CFG.STATUS_POSTED && !existing[r]) {
        var p = sh.getRange(r, 1, 1, sh.getLastColumn()).protect().setDescription('مرحل-' + r);
        p.removeEditors(p.getEditors());
        var allowed = dedupe_(priv.concat([me])).filter(String);
        p.addEditors(allowed);
        if (p.canDomainEdit()) p.setDomainEdit(false);
      }
    }
  });
}

/* ========================= الإقفال ========================= */
function checkClosingReadiness() {
  var ss = SpreadsheetApp.getActive();
  var crit = ss.getRangeByName('CK_Critical');
  var rev = ss.getRangeByName('CK_Review');
  var n = crit ? crit.getValue() : 'غير معروف';
  var m = rev ? rev.getValue() : 'غير معروف';
  SpreadsheetApp.getUi().alert('بنود حرجة تمنع الإقفال: ' + n + '\nبنود للمراجعة: ' + m + '\n(انظر ورقة Close_Checklist)');
}

/**
 * يقفل الفترة المحددة في Settings: يرفض إن وُجدت بنود حرجة، وإلا يكتب لقطة القيم (الإيرادات/الربح/المدين/الدائن)
 * في Period_Close ويضع الحالة (مقفلة) واسم المُقفِل (بريد المستخدم) وتاريخ الإقفال.
 */
function closePeriod() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActive();
  var user = Session.getActiveUser().getEmail();
  if (!isPrivileged_(user)) { ui.alert('الإقفال مسموح للمدير المالي/الإدارة العليا فقط.'); return; }
  var crit = ss.getRangeByName('CK_Critical').getValue();
  if (crit > 0) { ui.alert('لا يمكن الإقفال: توجد ' + crit + ' بنود حرجة في Close_Checklist.'); return; }
  var pid = ss.getRangeByName('S_PeriodID').getValue();
  var from = ss.getRangeByName('S_From').getValue();
  var to = ss.getRangeByName('S_To').getValue();
  var eom = new Date(from.getFullYear(), from.getMonth() + 1, 0);
  if (from.getDate() !== 1 || to.getTime() !== eom.getTime()) { ui.alert('الفترة المحددة ليست شهرًا كاملًا.'); return; }
  var resp = ui.alert('إقفال الفترة ' + pid + ' ؟', 'سيُسجَّل الإقفال باسمك (' + user + ') ويُحفظ لقطة بالأرقام.', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var sh = ss.getSheetByName(CFG.PERIOD_SHEET);
  var vals = sh.getRange(CFG.FIRST_ROW, 1, sh.getMaxRows() - CFG.FIRST_ROW + 1, 1).getValues();
  var row = -1;
  for (var i = 0; i < vals.length; i++) { if (vals[i][0] === pid) { row = CFG.FIRST_ROW + i; break; } }
  if (row < 0) {
    for (var j = 0; j < vals.length; j++) { if (vals[j][0] === '' ) { row = CFG.FIRST_ROW + j; break; } }
    sh.getRange(row, 1).setValue(pid);
  }
  var live = function (title) { var c = findHeaderCol_(sh, title); return c > 0 ? sh.getRange(row, c).getValue() : null; };
  var set = function (title, v) { var c = findHeaderCol_(sh, title); if (c > 0) sh.getRange(row, c).setValue(v); };
  set('لقطة: صافي الإيرادات', live('حي: صافي الإيرادات'));
  set('لقطة: صافي الربح', live('حي: صافي الربح'));
  set('لقطة: إجمالي المدين', live('حي: إجمالي المدين'));
  set('لقطة: إجمالي الدائن', live('حي: إجمالي الدائن'));
  set('تاريخ الإقفال', new Date());
  set('الحالة', 'مقفلة');
  ui.alert('تم إقفال الفترة ' + pid + '. اكتب اسم (المُقفِل) و(المعتمد الثاني) من القوائم، ثم وقّع محضر الإقفال (نموذج 26).');
}

/* ========================= نسخة احتياطية ========================= */
function backupNow() {
  var ss = SpreadsheetApp.getActive();
  var stamp = Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd_HH-mm');
  var file = DriveApp.getFileById(ss.getId());
  var copy = file.makeCopy('Satamoni_Backup_' + stamp);
  if (CFG.BACKUP_FOLDER_ID) {
    DriveApp.getFolderById(CFG.BACKUP_FOLDER_ID).addFile(copy);
    DriveApp.getRootFolder().removeFile(copy);
  }
  SpreadsheetApp.getUi().alert('تم إنشاء النسخة: ' + copy.getName());
}

/* ========================= دوال مساعدة ========================= */
function findHeaderCol_(sh, startsWith) {
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(CFG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < hdr.length; i++) {
    if (String(hdr[i]).replace(/\n.*/, '').indexOf(startsWith) === 0) return i + 1;
  }
  return -1;
}

/** نطاقات الإدخال = الأعمدة التي لون رأسها أزرق (1F4E78) في صف العناوين. */
function inputRanges_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return [];
  var bg = sh.getRange(CFG.HEADER_ROW, 1, 1, lastCol).getBackgrounds()[0];
  var rows = Math.max(sh.getMaxRows() - CFG.HEADER_ROW, 1);
  var out = [];
  for (var c = 0; c < bg.length; c++) {
    if (String(bg[c]).toLowerCase() === '#1f4e78') out.push(sh.getRange(CFG.FIRST_ROW, c + 1, rows, 1));
  }
  // أوراق الإعدادات (قيم صفراء في العمود C)
  var n = sh.getName();
  if (n === 'Settings' || n === 'Tax_Settings') out.push(sh.getRange('C5:C30'));
  if (n === 'GL_Ledger') out.push(sh.getRange('B4:B9'));
  ['Trial_Balance', 'Income_Statement', 'Balance_Sheet', 'Cash_Flow', 'Treasury_Balances', 'Supplier_Balances', 'Customer_Balances']
    .forEach(function (x) { if (n === x) out.push(sh.getRange('B4:B8')); });
  return out;
}

function emailsByRole_(roles) {
  var sh = SpreadsheetApp.getActive().getSheetByName(CFG.USERS_SHEET);
  if (!sh) return [];
  var data = sh.getRange(CFG.FIRST_ROW, 1, Math.max(sh.getLastRow() - CFG.FIRST_ROW + 1, 1), 6).getValues();
  var out = [];
  data.forEach(function (r) {
    var email = String(r[2] || '').trim();
    var role = String(r[3] || '').trim();
    var active = String(r[5] || '').trim();
    if (email && email.indexOf('@') > 0 && email !== 'user@example.com' && roles.indexOf(role) >= 0 && active !== 'لا') out.push(email);
  });
  return dedupe_(out);
}

function isPrivileged_(email) {
  var owner = '';
  try { owner = SpreadsheetApp.getActive().getOwner().getEmail(); } catch (e) {}
  return !!email && (email === owner || emailsByRole_(CFG.PRIVILEGED_ROLES).indexOf(email) >= 0);
}

function dedupe_(a) {
  var seen = {};
  return a.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; });
}
