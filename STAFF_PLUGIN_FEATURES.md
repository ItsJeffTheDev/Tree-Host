> **Superseded:** the Staff Plugin page and its API are now part of Managed Plugins. See [REQUIRED_PLUGINS_FEATURE.md](REQUIRED_PLUGINS_FEATURE.md).

# TreeHostStaff Plugin Features - Implementation Summary

## What Was Added

### 1. Plugin Description Popup (Dashboard)

**File Modified:** `public/app.js`

**What it does:**
- The TreeHostStaff plugin name in the plugins list is now clickable
- Clicking it opens a modal popup with detailed information about the plugin
- Explains what the plugin does, its features, security aspects, and version management

**Changes:**
- Added `staff-plugin-row` and `staff-plugin-name` CSS classes to identify the plugin
- Added click handler to show `showStaffPluginInfo()` modal
- Created `showStaffPluginInfo()` function with comprehensive plugin information

**User experience:**
- Users can click on "TreeHostStaff" in the plugins list
- A popup appears explaining:
  - What the plugin is
  - Features (staff can always join, protection, visual identification, etc.)
  - Security (cannot be removed/disabled)
  - Staff list management
  - Version information

### 2. Admin Console Section for Staff Plugin

**File Modified:** `public/console.js`

**What it does:**
- Added a new "Staff Plugin" section to the Staff Console
- Shows current plugin version, file size, SHA256 hash, upload date, and uploader
- Allows Owner, Admin, and Developer roles to upload a new JAR file
- Includes version field and release notes

**Changes:**
- Added new console section: `{ id: 'staff-plugin', icon: 'puzzle', label: 'Staff Plugin', perm: 'system.view', render: consoleStaffPlugin }`
- Created `consoleStaffPlugin()` function that:
  - Displays current plugin information
  - Shows upload form for users with `system.manage` permission
  - Handles file upload with validation
  - Updates UI after successful upload

**Permission requirements:**
- View: `system.view` (Owner, Admin, Developer, Staff)
- Update: `system.manage` (Owner, Admin, Developer)

### 3. Server API Endpoints

**File Modified:** `src/server.js`

**What it does:**
- Added two new API endpoints for staff plugin management
- `GET /api/admin/staff-plugin` - Get current plugin info
- `POST /api/admin/staff-plugin` - Upload new plugin JAR

**Changes:**
- Added `STAFF_PLUGIN_INFO_FILE` constant for metadata storage
- Created `loadStaffPluginInfo()` to read plugin metadata
- Created `saveStaffPluginInfo()` to save plugin metadata
- Added GET endpoint that returns:
  - Version
  - File size
  - SHA256 hash
  - Upload date
  - Uploader username
  - Release notes
- Added POST endpoint that:
  - Accepts multipart form data (JAR file, version, notes)
  - Validates file is a valid JAR (ZIP archive)
  - Limits file size to 50MB
  - Saves new JAR to `minecraft-plugin/TreeHostStaff.jar`
  - Updates in-memory cache
  - Saves metadata to `staff-plugin-info.json`
  - Logs the update to activity feed

**API Details:**

**GET /api/admin/staff-plugin**
- Permission: `system.view`
- Returns: Plugin info object
- Fallback: Returns default info if file doesn't exist

**POST /api/admin/staff-plugin**
- Permission: `system.manage`
- Accepts: Multipart form data
  - `jarFile`: The JAR file (max 50MB)
  - `version`: Version string (required)
  - `notes`: Release notes (optional)
- Validation:
  - Must be a valid JAR file (ZIP archive)
  - File size between 1 byte and 50MB
  - Version is required
- Actions:
  - Saves JAR to `minecraft-plugin/TreeHostStaff.jar`
  - Updates `staffPluginJar` in-memory cache
  - Recalculates SHA256 hash
  - Saves metadata to `staff-plugin-info.json`
  - Logs to activity feed

## How It Works

### For Users (Dashboard)

1. Go to a server's Plugins tab
2. Look for "TreeHostStaff" in the plugin list (marked with "Required by Tree Host" badge)
3. Click on the plugin name
4. A popup appears with detailed information about the plugin

### For Admins (Staff Console)

1. Go to Staff Console (/admin)
2. Click "Staff Plugin" in the sidebar
3. View current plugin information:
   - Version
   - File size
   - SHA256 hash
   - Upload date
   - Who uploaded it
   - Release notes
4. To update:
   - Click "Choose File" and select new JAR
   - Enter version (e.g., "1.0.0")
   - Optionally add release notes
   - Click "Update Plugin"
5. The plugin is updated across all servers automatically (existing sync mechanism)

## File Structure

**New/Modified Files:**
- `public/app.js` - Plugin popup UI
- `public/console.js` - Admin console section
- `src/server.js` - API endpoints
- `minecraft-plugin/TreeHostStaff.jar` - Plugin JAR (updated by admins)
- `data/staff-plugin-info.json` - Plugin metadata (created on first upload)

## Security Considerations

- Only users with `system.manage` permission can upload (Owner, Admin, Developer)
- File upload limited to 50MB
- JAR file validation (must be ZIP archive)
- SHA256 hash calculated and stored for integrity verification
- All uploads logged to activity feed
- Plugin cannot be removed/disabled by customers (existing protection)

## Testing

### Test Plugin Popup
1. Start a server (Paper, Spigot, etc.)
2. Go to Plugins tab
3. Click on "TreeHostStaff" plugin name
4. Verify popup appears with correct information

### Test Admin Upload
1. Sign in as Owner, Admin, or Developer
2. Go to Staff Console > Staff Plugin
3. Verify current plugin info displays
4. Upload a new JAR file with version and notes
5. Verify success message and updated info
6. Check activity feed for log entry
7. Verify `minecraft-plugin/TreeHostStaff.jar` was updated
8. Verify `data/staff-plugin-info.json` was created

## API Response Examples

**GET /api/admin/staff-plugin (default):**
```json
{
  "version": "1.0.0",
  "size": 12345,
  "hash": "abc123...",
  "uploadedAt": null,
  "uploadedBy": null,
  "notes": "Default plugin from minecraft-plugin/TreeHostStaff.jar"
}
```

**GET /api/admin/staff-plugin (after upload):**
```json
{
  "version": "1.1.0",
  "size": 15000,
  "hash": "def456...",
  "uploadedAt": 1698765432000,
  "uploadedBy": "admin",
  "notes": "Fixed compatibility with 1.21"
}
```

## Notes

- The plugin sync mechanism already exists in the codebase (`syncStaffPlugin` in server.js)
- When the JAR is updated, it will be synced to all servers on next start/check
- The plugin remains protected (cannot be deleted/disabled by customers)
- Version information is stored separately from the JAR file for easy access
- Release notes help track what changed in each version
