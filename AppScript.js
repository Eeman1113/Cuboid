// ============================================================
// Cuboid – Google Apps Script (Multi-User, Per-Sheet, 2-Way Sync)
// ============================================================
// Deploy as: Web App → Execute as YOU → Anyone can access
// Sheet layout per user tab:  ID | Time | Penalty | Scramble | Timestamp | Date
// A master "Users" sheet tracks userId → sheetName mapping.
// ============================================================

// --------------- helpers ---------------

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Mutual-exclusion lock — prevents concurrent writes from corrupting rows
function withLock(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return jsonResponse({ status: 'error', message: 'Server busy, please retry' });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sanitizeId(userId) {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);
}

// ─── Tombstones: remember deleted timestamps so other devices don't re-add them ───
function getTombstones(userId) {
  var key = 'del_' + sanitizeId(userId);
  var val = PropertiesService.getScriptProperties().getProperty(key);
  return val ? JSON.parse(val) : [];
}

function addTombstone(userId, timestamp) {
  var key = 'del_' + sanitizeId(userId);
  var arr = getTombstones(userId);
  var ts = String(timestamp);
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === ts) return; // already tracked
  }
  arr.push(ts);
  if (arr.length > 2000) arr = arr.slice(-2000);
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(arr));
}

function getTombstoneSet(userId) {
  var arr = getTombstones(userId);
  var set = {};
  for (var i = 0; i < arr.length; i++) set[arr[i]] = true;
  return set;
}

// ─── Sheet helpers ───
function getUserSheet(userId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var safeName = 'user_' + sanitizeId(userId);
  var sheet = ss.getSheetByName(safeName);
  if (sheet) return sheet;

  sheet = ss.insertSheet(safeName);
  sheet.appendRow(['ID', 'Time', 'Penalty', 'Scramble', 'Timestamp', 'Date']);
  sheet.setFrozenRows(1);

  var usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) {
    usersSheet = ss.insertSheet('Users');
    usersSheet.appendRow(['UserId', 'SheetName', 'CreatedAt']);
    usersSheet.setFrozenRows(1);
  }
  usersSheet.appendRow([userId, safeName, new Date().toISOString()]);
  return sheet;
}

function findUserSheet(userId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var safeName = 'user_' + sanitizeId(userId);
  return ss.getSheetByName(safeName) || null;
}

function getExistingTimestamps(sheet) {
  var lastRow = sheet.getLastRow();
  var set = {};
  if (lastRow > 1) {
    var vals = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i][0];
      if (v !== '' && v !== null && v !== undefined) {
        set[String(v)] = true;
      }
    }
  }
  return set;
}

// Remove blank/corrupt rows (timestamp AND time both empty)
function cleanupEmptyRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  // Scan bottom-to-top so deletions don't shift indices above
  for (var i = data.length - 1; i >= 0; i--) {
    if (!data[i][4] && !data[i][1]) {
      sheet.deleteRow(i + 2);
    }
  }
}

// Read all valid solves from sheet (skips empty rows)
function readAllSolves(sheet) {
  var lastRow = sheet.getLastRow();
  var solves = [];
  if (lastRow <= 1) return solves;
  var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (var i = 0; i < data.length; i++) {
    var ts = Number(data[i][4]) || 0;
    if (!ts) continue;
    solves.push({
      id: String(data[i][0]),
      time: Number(data[i][1]),
      penalty: data[i][2] || '',
      scramble: data[i][3] || '',
      timestamp: ts
    });
  }
  return solves;
}

// --------------- GET ---------------
// ?userId=xxx                → returns ALL solves for that user
// ?userId=xxx&since=<ts>     → returns solves with timestamp > since
function doGet(e) {
  try {
    var userId = (e.parameter && e.parameter.userId) ? e.parameter.userId.trim() : '';
    if (!userId) {
      return jsonResponse({ status: 'error', message: 'Missing userId' });
    }

    var sheet = findUserSheet(userId);
    if (!sheet) {
      return jsonResponse({ status: 'success', solves: [], timestamps: [] });
    }

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return jsonResponse({ status: 'success', solves: [], timestamps: [] });
    }

    var since = (e.parameter && e.parameter.since) ? Number(e.parameter.since) : 0;
    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    var solves = [];
    var timestamps = [];

    for (var i = 0; i < data.length; i++) {
      var ts = Number(data[i][4]) || 0;
      if (!ts) continue; // skip empty rows
      timestamps.push(ts);
      if (ts > since) {
        solves.push({
          id: String(data[i][0]),
          time: Number(data[i][1]),
          penalty: data[i][2] || '',
          scramble: data[i][3] || '',
          timestamp: ts
        });
      }
    }

    return jsonResponse({ status: 'success', solves: solves, timestamps: timestamps });
  } catch (error) {
    return jsonResponse({ status: 'error', message: error.message });
  }
}

// --------------- POST ---------------
// Body JSON must include "userId": "xxx"
// Actions:
//   { userId, action: "delete", timestamp }
//   { userId, action: "updatePenalty", timestamp, penalty }
//   { userId, action: "sync", solves: [...] }
//   { userId, id, time, penalty, scramble, timestamp }   ← single insert
//   [ ... ]  array with userId inside each element         ← bulk insert
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    var userId = '';
    if (Array.isArray(payload)) {
      userId = (payload[0] && payload[0].userId) ? payload[0].userId : '';
    } else {
      userId = payload.userId || '';
    }
    userId = String(userId).trim();

    if (!userId) {
      return jsonResponse({ status: 'error', message: 'Missing userId' });
    }

    // --- DELETE ---
    if (!Array.isArray(payload) && payload.action === 'delete') {
      return withLock(function() {
        var ts = String(payload.timestamp);
        if (!ts) return jsonResponse({ status: 'error', message: 'Missing timestamp' });

        addTombstone(userId, ts);
        var sheet = findUserSheet(userId);
        if (!sheet) return jsonResponse({ status: 'success' });

        var lastRow = sheet.getLastRow();
        if (lastRow <= 1) return jsonResponse({ status: 'success' });

        var tsCol = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
        // Scan bottom-to-top: delete ALL matches, indices stay valid above
        for (var i = tsCol.length - 1; i >= 0; i--) {
          if (String(tsCol[i][0]) === ts) {
            sheet.deleteRow(i + 2);
          }
        }
        return jsonResponse({ status: 'success' });
      });
    }

    // --- UPDATE PENALTY ---
    if (!Array.isArray(payload) && payload.action === 'updatePenalty') {
      return withLock(function() {
        var sheet = findUserSheet(userId);
        if (!sheet) return jsonResponse({ status: 'success' });

        var ts2 = String(payload.timestamp);
        var penalty = String(payload.penalty || '');

        var lastRow2 = sheet.getLastRow();
        if (lastRow2 <= 1) return jsonResponse({ status: 'success' });

        var tsCol2 = sheet.getRange(2, 5, lastRow2 - 1, 1).getValues();
        for (var i = 0; i < tsCol2.length; i++) {
          if (String(tsCol2[i][0]) === ts2) {
            sheet.getRange(i + 2, 3).setValue(penalty);
          }
        }
        return jsonResponse({ status: 'success' });
      });
    }

    // --- SYNC (bulk upsert + return what server has) ---
    if (!Array.isArray(payload) && payload.action === 'sync') {
      return withLock(function() {
        var clientSolves = payload.solves || [];
        var tombstoneSet = getTombstoneSet(userId);
        var tombstoneList = getTombstones(userId);

        var liveSolves = clientSolves.filter(function(s) {
          return s.timestamp && !tombstoneSet[String(s.timestamp)];
        });

        var sheet = findUserSheet(userId);

        if (!sheet && liveSolves.length === 0) {
          return jsonResponse({ status: 'success', inserted: 0, solves: [], deleted: tombstoneList });
        }
        if (!sheet) sheet = getUserSheet(userId);

        // Cleanup empty rows before reading
        cleanupEmptyRows(sheet);

        var existingTs = getExistingTimestamps(sheet);

        // Collect new rows to append
        var newRows = [];
        for (var i = 0; i < liveSolves.length; i++) {
          var s = liveSolves[i];
          if (s.timestamp && !existingTs[String(s.timestamp)]) {
            newRows.push([
              s.id || '',
              Number(s.time) || 0,
              String(s.penalty || ''),
              String(s.scramble || ''),
              s.timestamp,
              new Date(s.timestamp).toISOString()
            ]);
            existingTs[String(s.timestamp)] = true;
          }
        }

        // Append at bottom — atomic write, no row shifting
        if (newRows.length > 0) {
          var insertAt = sheet.getLastRow() + 1;
          sheet.getRange(insertAt, 1, newRows.length, 6).setValues(newRows);
        }

        // Read all valid solves to send back
        var allSolves = readAllSolves(sheet);

        return jsonResponse({
          status: 'success',
          inserted: newRows.length,
          solves: allSolves,
          deleted: tombstoneList
        });
      });
    }

    // --- INSERT (single or array — legacy compatible) ---
    return withLock(function() {
      var sheet = getUserSheet(userId);
      var rows = [];
      if (Array.isArray(payload)) {
        for (var i = 0; i < payload.length; i++) {
          var d = payload[i];
          rows.push([
            d.id || '',
            Number(d.time) || 0,
            String(d.penalty || ''),
            String(d.scramble || ''),
            d.timestamp,
            new Date(d.timestamp).toISOString()
          ]);
        }
      } else {
        rows.push([
          payload.id || '',
          Number(payload.time) || 0,
          String(payload.penalty || ''),
          String(payload.scramble || ''),
          payload.timestamp,
          new Date(payload.timestamp).toISOString()
        ]);
      }

      if (rows.length === 0) {
        return jsonResponse({ status: 'success', inserted: 0 });
      }

      var existingTs3 = getExistingTimestamps(sheet);
      var tombstoneSet3 = getTombstoneSet(userId);
      var newRows3 = rows.filter(function(r) {
        return r[4] && !existingTs3[String(r[4])] && !tombstoneSet3[String(r[4])];
      });

      if (newRows3.length > 0) {
        var insertAt = sheet.getLastRow() + 1;
        sheet.getRange(insertAt, 1, newRows3.length, 6).setValues(newRows3);
      }

      return jsonResponse({ status: 'success', inserted: newRows3.length });
    });

  } catch (error) {
    return jsonResponse({ status: 'error', message: error.message });
  }
}
