# Required Plugins Feature - Implementation Summary

## What Was Added

A comprehensive **required plugins management system** that allows staff to upload, manage, and distribute plugins to all servers automatically.

## Features

### 1. Multi-Plugin Support
- Add multiple required plugins (not just TreeHostStaff)
- Each plugin has its own JAR file, metadata, and settings
- Plugins are stored in `required-plugins/` directory
- Metadata stored in `data/required-plugins.json`

### 2. Plugin Metadata
Each plugin can have:
- **Title** - Display name (e.g., "EssentialsX")
- **Description** - What the plugin does
- **Filename** - The JAR file name
- **Locked** - Whether customers can remove/disable it
- **Target Types** - Which server types it's for (Paper, Spigot, Purpur, Folia, CraftBukkit)
- **Size** - File size in bytes
- **SHA256** - File hash for integrity checking
- **Uploaded At** - Timestamp
- **Uploaded By** - Staff member who uploaded it

### 3. Admin Console UI
**File:** `public/console.js`

**New Section: "Required Plugins"**
- List of all required plugins
- Each plugin shows:
  - Title
  - Locked badge
  - Filename, size, target types
  - Action buttons: View, Edit, Distribute, Delete

**Add Plugin Modal:**
- Title input
- Description textarea
- JAR file upload (drag & drop)
- Lock checkbox
- Target server type checkboxes (Paper, Spigot, Purpur, Folia, CraftBukkit)

**View Plugin Modal:**
- Shows all plugin metadata
- Displays description
- File info (size, hash, etc.)

**Edit Plugin Modal:**
- Update title, description
- Toggle lock status
- Change target server types

**Distribute Action:**
- One-click distribution to all matching servers
- Shows success/failure count

### 4. Server-Side API
**File:** `src/server.js`

**New API Endpoints:**

**GET `/api/admin/required-plugins`**
- Returns list of all required plugins
- Permission: `system.view`
- Includes file existence status

**POST `/api/admin/required-plugins`**
- Upload a new required plugin
- Accepts: JAR file, title, description, locked, targetTypes
- Validates: JAR file (ZIP archive), max 50MB
- Saves to `required-plugins/` directory
- Adds to `required-plugins.json`
- Permission: `system.manage`

**PUT `/api/admin/required-plugins/:id`**
- Update plugin metadata
- Accepts: title, description, locked, targetTypes
- Permission: `system.manage`

**DELETE `/api/admin/required-plugins/:id`**
- Delete a required plugin
- Removes JAR file from `required-plugins/`
- Removes from `required-plugins.json`
- Does NOT remove from existing servers
- Permission: `system.manage`

**POST `/api/admin/required-plugins/:id/distribute`**
- Distribute plugin to all matching servers
- Checks server type against targetTypes
- Only distributes to bukkit-family servers
- Returns distributed/failed counts
- Permission: `system.manage`

### 5. Plugin Storage
**Directory:** `required-plugins/`

**File:** `data/required-plugins.json`

Example structure:
```json
[
  {
    "id": "abc123def456",
    "filename": "EssentialsX.jar",
    "title": "EssentialsX",
    "description": "Essential commands for your server",
    "locked": true,
    "targetTypes": ["paper", "spigot", "purpur"],
    "size": 1234567,
    "hash": "abc123...",
    "uploadedAt": 1234567890000,
    "uploadedBy": "admin",
    "updatedAt": 1234567890000,
    "updatedBy": "admin"
  }
]
```

## Usage

### For Staff (Admin/Owner/Developer)

1. **Add a Required Plugin:**
   - Go to Staff Console → Staff Plugin
   - Click "+ Add Required Plugin"
   - Fill in title and description
   - Upload JAR file (drag & drop or browse)
   - Choose target server types
   - Toggle lock if needed
   - Click "Add Plugin"

2. **View Plugin Info:**
   - Click "View" on a plugin
   - See all metadata and description

3. **Edit Plugin:**
   - Click "Edit" on a plugin
   - Update title, description, lock status, or target types
   - Click "Save Changes"

4. **Distribute to Servers:**
   - Click "Distribute" on a plugin
   - Confirm the action
   - Plugin is copied to all matching servers' plugin directories
   - See success/failure count

5. **Delete Plugin:**
   - Click "Delete" on a plugin
   - Confirm deletion
   - JAR file removed from `required-plugins/`
   - Plugin removed from list
   - (Not removed from existing servers)

## Security & Permissions

- **View:** `system.view` (Owner, Admin, Developer)
- **Add/Edit/Delete/Distribute:** `system.manage` (Owner, Admin, Developer)
- **Note:** The `system.manage` permission is separate from `system.view` to allow finer control
- **Locked plugins:** Cannot be removed/disabled by customers (like TreeHostStaff)
- **Unlocked plugins:** Customers can manage normally
- **File validation:** JAR files validated as ZIP archives
- **Size limit:** 50MB max per plugin
- **Hash verification:** SHA256 for integrity

### Role Permissions

**Owner:** All permissions (including `system.manage`)

**Admin:** All permissions except `roles.manage` and `servers.host` (includes `system.manage`)

**Developer:** `system.manage` added to allow managing required plugins (along with `system.view`)

**Staff:** No required plugin permissions (view only in console if allowed)

**Customer:** No permissions (cannot access staff console)

## Distribution Behavior

When distributing a plugin:
1. Checks all servers in the system
2. Filters by target server types (e.g., only Paper servers)
3. Filters by server family (must be bukkit: Paper, Spigot, Purpur, Folia, CraftBukkit)
4. Copies JAR file to each server's `plugins/` directory
5. Logs success/failure count
6. Activity log records the distribution

## Integration with Existing System

### TreeHostStaff Plugin
- Still managed separately (its own section)
- Still auto-installed via `syncStaffPlugin()`
- Remains the core staff management plugin

### Required Plugins
- Additional plugins beyond TreeHostStaff
- Managed via new UI
- Distributed on-demand (not automatic)
- Can be locked or unlocked

## Data Persistence

- **Plugin JARs:** Stored in `required-plugins/` directory
- **Metadata:** Stored in `data/required-plugins.json`
- **On servers:** Copied to server's `plugins/` directory on distribution
- **Re-deploy safe:** Plugin files persist across Tree Host redeploys

## Future Enhancements

Possible improvements:
- Automatic distribution on server creation
- Plugin version updates with changelog
- Plugin dependencies (require other plugins)
- Per-server plugin overrides
- Plugin enable/disable from admin console
- Bulk operations (distribute multiple at once)
- Plugin download from URL (not just upload)

## Files Modified

- `src/server.js` - Required plugins API endpoints and storage
- `public/console.js` - Admin console UI for plugin management
- `public/team.js` - Helper functions (openModal, esc, $, $$)

## Files Created

- `required-plugins/` - Directory for plugin JAR files (created at runtime)
- `data/required-plugins.json` - Plugin metadata (created at runtime)
- `REQUIRED_PLUGINS_FEATURE.md` - This documentation
