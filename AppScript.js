// ============================================================
// Cuboid – Google Apps Script (Multi-User, Per-Sheet, 2-Way Sync)
// ============================================================
// Deploy as: Web App → Execute as YOU → Anyone can access
// Sheet layout per user tab:  ID | Time | Penalty | Scramble | Timestamp | Date
// A master "Users" sheet tracks userId → sheetName mapping.
// ============================================================

// --------------- helpers ---------------

// ─── Tombstones: remember deleted timestamps so other devices don't re-add them ───
function getTombstones(userId) {
  var key = 'del_' + userId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);
  var val = PropertiesService.getScriptProperties().getProperty(key);
  return val ? JSON.parse(val) : [];
}
function addTombstone(userId, timestamp) {
  var key = 'del_' + userId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);
  var arr = getTombstones(userId);
  arr.push(String(timestamp));
  if (arr.length > 1000) arr = arr.slice(-1000); // cap to avoid quota
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(arr));
}
function getTombstoneSet(userId) {
  var arr = getTombstones(userId);
  var set = {};
  for (var i = 0; i < arr.length; i++) set[arr[i]] = true;
  return set;
}

function getUserSheet(userId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Sanitise: sheet names can't exceed 100 chars or contain certain chars
  var safeName = 'user_' + userId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);

  var sheet = ss.getSheetByName(safeName);
  if (sheet) return sheet;

  // Create new sheet for this user
  sheet = ss.insertSheet(safeName);
  sheet.appendRow(['ID', 'Time', 'Penalty', 'Scramble', 'Timestamp', 'Date']);
  sheet.setFrozenRows(1);

  // Register in Users index
  var usersSheet = ss.getSheetByName('Users');
  if (!usersSheet) {
    usersSheet = ss.insertSheet('Users');
    usersSheet.appendRow(['UserId', 'SheetName', 'CreatedAt']);
    usersSheet.setFrozenRows(1);
  }
  usersSheet.appendRow([userId, safeName, new Date().toISOString()]);

  return sheet;
}

function getExistingTimestamps(sheet) {
  var lastRow = sheet.getLastRow();
  var set = {};
  if (lastRow > 1) {
    var vals = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0]) set[String(vals[i][0])] = true;
    }
  }
  return set;
}

// Read-only: returns existing sheet or null (never creates)
function findUserSheet(userId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var safeName = 'user_' + userId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 80);
  return ss.getSheetByName(safeName) || null;
}

// --------------- GET ---------------
// ?userId=xxx                → returns ALL solves for that user
// ?userId=xxx&since=<ts>     → returns solves with timestamp > since  (for delta sync)
// (no userId)                → returns error

function doGet(e) {
  try {
    var userId = (e.parameter && e.parameter.userId) ? e.parameter.userId.trim() : '';
    if (!userId) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Missing userId' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // Don't create a sheet just for reading — return empty if none exists
    var sheet = findUserSheet(userId);
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', solves: [], timestamps: [] })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var lastRow = sheet.getLastRow();

    if (lastRow <= 1) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', solves: [], timestamps: [] })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var since = (e.parameter && e.parameter.since) ? Number(e.parameter.since) : 0;
    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    var solves = [];
    var timestamps = [];

    for (var i = 0; i < data.length; i++) {
      var ts = Number(data[i][4]) || 0;
      timestamps.push(ts);
      if (ts > since) {
        solves.push({
          id:        String(data[i][0]),
          time:      Number(data[i][1]),
          penalty:   data[i][2] || '',
          scramble:  data[i][3] || '',
          timestamp: ts
        });
      }
    }

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'success', solves: solves, timestamps: timestamps })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: error.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// --------------- POST ---------------
// Body JSON must include  "userId": "xxx"
// Actions:
//   { userId, action: "delete", timestamp }
//   { userId, action: "updatePenalty", timestamp, penalty }
//   { userId, action: "sync", solves: [...] }      ← bulk upsert (used by 2-way sync)
//   { userId, id, time, penalty, scramble, timestamp }   ← single insert (legacy compat)
//   [ ... ]  array with userId inside each element         ← bulk insert

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // --- Determine userId ---
    var userId = '';
    if (Array.isArray(payload)) {
      userId = (payload[0] && payload[0].userId) ? payload[0].userId : '';
    } else {
      userId = payload.userId || '';
    }
    if (!userId) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'error', message: 'Missing userId' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = null; // will be assigned per-action

    // --- DELETE ---
    if (!Array.isArray(payload) && payload.action === 'delete') {
      var ts = String(payload.timestamp);
      // Record tombstone FIRST so no other device can re-add it
      addTombstone(userId, ts);
      sheet = findUserSheet(userId);
      if (!sheet) return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        var tsCol = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
        for (var i = 0; i < tsCol.length; i++) {
          if (String(tsCol[i][0]) === ts) {
            sheet.deleteRow(i + 2);
            break;
          }
        }
      }
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // --- UPDATE PENALTY ---
    if (!Array.isArray(payload) && payload.action === 'updatePenalty') {
      sheet = findUserSheet(userId);
      if (!sheet) return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
      var ts2 = String(payload.timestamp);
      var lastRow2 = sheet.getLastRow();
      if (lastRow2 > 1) {
        var tsCol2 = sheet.getRange(2, 5, lastRow2 - 1, 1).getValues();
        for (var i = 0; i < tsCol2.length; i++) {
          if (String(tsCol2[i][0]) === ts2) {
            sheet.getRange(i + 2, 3).setValue(payload.penalty);
            break;
          }
        }
      }
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // --- SYNC (bulk upsert + return what server has that client doesn't) ---
    if (!Array.isArray(payload) && payload.action === 'sync') {
      var clientSolves = payload.solves || [];
      var tombstoneSet = getTombstoneSet(userId);
      var tombstoneList = getTombstones(userId);

      // Only create sheet if there are non-tombstoned solves to write
      var sheet = findUserSheet(userId);
      var liveSolves = clientSolves.filter(function(s) { return s.timestamp && !tombstoneSet[String(s.timestamp)]; });

      if (!sheet && liveSolves.length === 0) {
        return ContentService.createTextOutput(
          JSON.stringify({ status: 'success', inserted: 0, solves: [], deleted: tombstoneList })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      if (!sheet) sheet = getUserSheet(userId);

      var existingTs = getExistingTimestamps(sheet);

      // Insert new solves from client (skip tombstoned ones)
      var newRows = [];
      for (var i = 0; i < liveSolves.length; i++) {
        var s = liveSolves[i];
        if (s.timestamp && !existingTs[String(s.timestamp)]) {
          newRows.push([s.id, s.time, s.penalty, s.scramble, s.timestamp, new Date(s.timestamp).toLocaleString()]);
          existingTs[String(s.timestamp)] = true;
        }
      }

      if (newRows.length > 0) {
        newRows.sort(function(a, b) { return b[4] - a[4]; });
        sheet.insertRowsBefore(2, newRows.length);
        sheet.getRange(2, 1, newRows.length, newRows[0].length).setValues(newRows);
      }

      // Now read ALL solves to send back to client
      var lastRowSync = sheet.getLastRow();
      var allSolves = [];
      if (lastRowSync > 1) {
        var allData = sheet.getRange(2, 1, lastRowSync - 1, 6).getValues();
        for (var j = 0; j < allData.length; j++) {
          allSolves.push({
            id:        String(allData[j][0]),
            time:      Number(allData[j][1]),
            penalty:   allData[j][2] || '',
            scramble:  allData[j][3] || '',
            timestamp: Number(allData[j][4]) || 0
          });
        }
      }

      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', inserted: newRows.length, solves: allSolves, deleted: tombstoneList })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // --- INSERT (single or array – legacy compatible) ---
    sheet = getUserSheet(userId); // creates sheet if needed — we have data to write
    var rows = [];
    if (Array.isArray(payload)) {
      rows = payload.map(function(d) {
        return [d.id, d.time, d.penalty, d.scramble, d.timestamp, new Date(d.timestamp).toLocaleString()];
      });
    } else {
      rows = [[payload.id, payload.time, payload.penalty, payload.scramble, payload.timestamp, new Date(payload.timestamp).toLocaleString()]];
    }

    if (rows.length === 0) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', inserted: 0 })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var existingTs3 = getExistingTimestamps(sheet);
    var tombstoneSet3 = getTombstoneSet(userId);
    var newRows3 = rows.filter(function(r) { return r[4] && !existingTs3[String(r[4])] && !tombstoneSet3[String(r[4])]; });

    if (newRows3.length > 0) {
      newRows3.sort(function(a, b) { return b[4] - a[4]; });
      sheet.insertRowsBefore(2, newRows3.length);
      sheet.getRange(2, 1, newRows3.length, newRows3[0].length).setValues(newRows3);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ status: 'success', inserted: newRows3.length })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: error.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
