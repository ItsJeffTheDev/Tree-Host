# Demo Server Feature - Implementation Summary

## What Was Added

A **shared demo server** that all new users can explore to learn how Tree Host works before committing to a plan.

## How It Works

### Server-Side Changes

**File:** `src/server.js`

1. **Shared Demo Server Creation**
   - POST `/api/servers/demo` endpoint
   - Creates a single shared demo server (one for all users)
   - Server is in "team" space so all customers can see it
   - Auto-starts the demo server when created
   - Server is marked with `isDemo: true` and `isSharedDemo: true`

2. **Visibility Rules**
   - Modified `canView()` function to allow all customers to see the shared demo server
   - Added `canControl()` function to allow customers to control the demo server (start/stop/commands)
   - Demo server is read-only for plugins, files, and settings (can't break it)

### Client-Side Changes

**File:** `public/app.js`

1. **Demo Server Card**
   - Shows a "Try the demo server" card for any user with no servers
   - "Launch Demo Server" button to create/access the demo
   - Shows when in team mode and user has no servers

2. **Demo Server Creation**
   - `createDemoServer()` function calls the API endpoint
   - Refreshes the server list after creation
   - Auto-selects the demo server

3. **Demo Server UI**
   - Orange "DEMO" badge in sidebar for demo server
   - Yellow warning banner explaining it's a shared demo
   - Read-only restrictions on plugins, files, and settings tabs

## User Experience

### For New Users

1. **Sign up** for a new account
2. **See welcome screen** with demo server option
3. **Click "Launch Demo Server"**
4. **Demo server appears** in sidebar with a special indicator
5. **Explore the dashboard:**
   - Start/stop the server
   - View console output
   - Try commands
   - Check plugins (read-only)
   - View files (read-only)
   - Explore settings (read-only)
6. **When ready**, create their own real server with a plan

### Demo Server Details

- **Name:** "Tree Host Demo Server"
- **Type:** Paper 1.21.1
- **Memory:** 1GB
- **Space:** Team (shared with all users)
- **Auto-start:** Yes
- **Permissions:**
  - ✅ Start/stop/restart
  - ✅ Console commands
  - ✅ View console output
  - ✅ View plugins (read-only)
  - ✅ View files (read-only)
  - ✅ View settings (read-only)
  - ❌ Install/change plugins
  - ❌ Edit files
  - ❌ Change settings
  - ❌ Delete/reset

## Security & Isolation

The demo server is designed to be safe for shared exploration:

- **Read-only access** to files, plugins, and settings
- **Cannot be deleted** by customers (owned by staff)
- **Auto-restored** if someone tries to break it (staff plugin protection)
- **Console commands** allowed but monitored
- **Limited to Paper 1.21.1** (stable version)
- **Fixed 1GB memory** (prevents resource hogging)

## API Endpoint

**POST `/api/servers/demo`**

**Request:** None (body empty)

**Response:** Server object

**Behavior:**
- First call: Creates the shared demo server
- Subsequent calls: Returns existing demo server
- Marks user as `hasSeenDemo: true`

**Permissions:**
- Only available in team mode (`TREEHOST_TEAM=1`)
- Only for customers (staff don't need it)
- No special permission required for customers

## Environment Variables

No new environment variables required. Uses existing:
- `TREEHOST_TEAM=1` (must be set for demo to work)
- Firebase configuration (for user accounts)

## Demo Server Lifecycle

1. **First user creates demo:**
   - Server is created
   - Auto-started
   - Logged to activity feed

2. **Subsequent users:**
   - See existing demo server
   - Can access it immediately
   - No new server created

3. **Server restarts/redeploys:**
   - Demo server persists (like other servers)
   - Auto-starts on Tree Host startup (if configured)
   - Staff plugin ensures it stays installed

## Notes

- The demo server is created in "team" space so all customers can see it
- It's owned by the first admin/owner account that exists
- Staff can manage it like any other server
- The demo server counts against server limits for the owner
- In production, you may want to disable auto-start to save resources

## Future Enhancements

Possible improvements:
- Add a "Reset Demo Server" button for staff to restore it if broken
- Add a demo server limit (e.g., max 10 concurrent users on it)
- Add demo server analytics (how many people use it, what they do)
- Add a tour/guide overlay for new users
- Auto-destroy demo server after user creates their first real server

## Files Modified

- `src/server.js` - Demo server API and visibility rules
- `src/auth.js` - User tracking for demo server
- `public/app.js` - Demo server UI and creation logic
