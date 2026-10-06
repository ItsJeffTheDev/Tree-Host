# User Details & Account Management - Implementation Summary

## What Was Added

A comprehensive user details modal and account management system for the admin People section, allowing staff to view detailed user information, activity logs, and send custom email-based resets.

## Features

### 1. User Details Modal
**File:** `public/team.js`

**Shows when clicking "View Details" on a user:**

**Account Information:**
- Username
- Email address
- Role (with badge)
- Join date
- Last login date
- Minecraft name
- Firebase UID (if applicable)
- Account status (restricted/suspended)
- Priority support status
- Lifetime plan status

**Servers List:**
- Number of servers
- Each server's:
  - Name
  - Type (Paper, Spigot, etc.)
  - Version
  - Status
  - Memory allocation
  - Disk usage

**Subscriptions:**
- Number of subscriptions
- Each subscription's:
  - Plan name
  - Status (active, past_due, etc.)
  - RAM allocation
  - Start date
  - End date

**Recent Activity:**
- Last 50 activity events
- Timestamp, kind, and description
- Filtered to user-specific activities

**Linked Accounts:**
- Number of linked accounts
- Each linked account's:
  - Username
  - Role

### 2. Custom Email Reset System
**File:** `src/server.js`

**New API Endpoints:**

**GET `/api/admin/users/:uid/details`**
- Returns detailed user information
- Includes servers, subscriptions, activity logs
- Permission: `users.view`

**POST `/api/admin/users/:uid/reset-password`**
- Sends password reset email
- Generates secure reset token (1 hour expiry)
- Returns reset link (for testing - remove in production)
- **TODO:** Implement actual email sending with custom template
- Permission: `users.manage`

**POST `/api/admin/users/:uid/change-email`**
- Requests email change
- Sends verification email to new address
- Generates verification token (24 hour expiry)
- Returns verification link (for testing - remove in production)
- **TODO:** Implement actual email sending with custom template
- Permission: `users.manage`

### 3. Admin Console UI
**File:** `public/team.js`

**New Action Buttons:**
- **View Details** - Opens detailed user modal
- **Change Email** - Opens email change modal
- **Send password reset email** - Existing, updated to use new API

**Email Change Modal:**
- Input for new email address
- Sends verification email to new address
- User must click link to confirm
- Shows hint about verification process

## Usage

### For Staff (Admin/Owner/Developer)

1. **View User Details:**
   - Go to Staff Console → People
   - Click "More" on a user
   - Click "View Details"
   - See complete account information, servers, subscriptions, and activity

2. **Send Password Reset:**
   - Click "More" on a user
   - Click "Send password reset email"
   - User receives email with reset link
   - Link expires in 1 hour

3. **Change User Email:**
   - Click "More" on a user
   - Click "Change Email"
   - Enter new email address
   - Verification email sent to new address
   - User must click link to confirm
   - Verification link expires in 24 hours

## Custom Email Implementation

### Current State (Testing)
- Password reset and email change endpoints generate tokens
- Return reset/verification links in response (for testing)
- Links should be removed in production

### TODO: Production Email Setup

To implement custom email sending:

1. **Choose an email service:**
   - Resend (recommended - `RESEND_API_KEY` already supported)
   - SendGrid
   - Mailgun
   - AWS SES
   - Custom SMTP

2. **Create email templates:**
   - `emails/password-reset.html` - Password reset email
   - `emails/email-verification.html` - Email change verification

3. **Email templates should include:**
   - Tree Host branding
   - User's name
   - Action required (reset password / verify email)
   - Secure reset/verification link
   - Expiration warning
   - Support contact info
   - Footer with unsubscribe/opt-out options

4. **Implement email sending function:**
   ```javascript
   async function sendCustomEmail(to, subject, htmlContent) {
     // Use your email service API
     // Example with Resend:
     // await resend.emails.send({
     //   from: 'Tree Host <noreply@treehost.online>',
     //   to: to,
     //   subject: subject,
     //   html: htmlContent,
     // });
   }
   ```

5. **Update endpoints:**
   - Remove `resetLink` and `verifyLink` from responses
   - Call `sendCustomEmail()` with template content
   - Handle email delivery errors

### Email Template Example (Password Reset)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reset Your Password</title>
</head>
<body style="font-family:Arial,sans-serif;line-height:1.6">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <h1 style="color:#2d5a27">Tree Host</h1>
    <p>Hi {{username}},</p>
    <p>We received a request to reset your password. Click the button below to set a new password:</p>
    <a href="{{resetLink}}" style="display:inline-block;padding:12px 24px;background:#2d5a27;color:#fff;text-decoration:none;border-radius:4px">Reset Password</a>
    <p style="font-size:12px;color:#666">This link expires in 1 hour for your security.</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
    <hr style="margin:20px 0;border:none;border-top:1px solid #eee">
    <p style="font-size:12px;color:#666">
      Need help? Contact us at support@treehost.online<br>
      © 2026 Tree Host. All rights reserved.
    </p>
  </div>
</body>
</html>
```

## Security & Permissions

- **View details:** `users.view` (Owner, Admin, Developer, Staff)
- **Send password reset:** `users.manage` (Owner, Admin, Developer)
- **Change email:** `users.manage` (Owner, Admin, Developer)
- **Token security:**
  - Password reset tokens: 32-byte random hex
  - Email verification tokens: 32-byte random hex
  - Reset tokens expire in 1 hour
  - Verification tokens expire in 24 hours
  - Tokens stored in user object in auth.js

## Data Returned by User Details Endpoint

```json
{
  "id": "user123",
  "username": "player123",
  "email": "user@example.com",
  "role": "customer",
  "roleLabel": "Customer",
  "createdAt": 1234567890000,
  "lastLogin": 1234567890000,
  "firebaseUid": "abc123",
  "mcName": "Player123",
  "restriction": null,
  "prioritySupport": false,
  "lifetime": false,
  "servers": [
    {
      "id": "srv123",
      "name": "My Server",
      "type": "paper",
      "version": "1.21.1",
      "status": "running",
      "memoryMb": 2048,
      "diskUsedMb": 512,
      "createdAt": 1234567890000
    }
  ],
  "subscriptions": [
    {
      "id": "sub123",
      "planName": "Premium",
      "status": "active",
      "ramMb": 2048,
      "startedAt": 1234567890000,
      "endsAt": 1234567890000
    }
  ],
  "activity": [
    {
      "t": 1234567890000,
      "kind": "server",
      "text": "created server 'My Server'"
    }
  ],
  "linked": [
    {
      "id": "user456",
      "username": "altaccount",
      "role": "customer"
    }
  ]
}
```

## Integration with Existing System

### People Section
- Existing People table unchanged
- New "View Details" button added to More menu
- New "Change Email" button added to More menu
- Existing password reset button uses new API

### Activity Logs
- Reuses existing activity system
- Filters to user-specific activities
- Shows last 50 events

### Servers & Subscriptions
- Reuses existing manager and billing systems
- Shows live data from instances and subscriptions
- No separate storage needed

## Future Enhancements

Possible improvements:
- Export user data to CSV/PDF
- User account history/timeline
- Bulk actions (reset multiple users)
- Email delivery tracking
- Custom email template editor in admin console
- SMS 2FA reset option
- Account recovery questions
- Audit log for password resets and email changes

## Files Modified

- `src/server.js` - User details API endpoints, password reset, email change
- `public/team.js` - User details modal, email change modal, People section UI
- `src/auth.js` - Password reset token storage (modified to support tokens)

## Files Created

- `USER_DETAILS_FEATURE.md` - This documentation

## Testing Checklist

- [ ] View user details modal shows all information
- [ ] Servers list displays correctly
- [ ] Subscriptions list displays correctly
- [ ] Activity logs show user-specific events
- [ ] Password reset generates token
- [ ] Password reset link works (in testing)
- [ ] Email change generates verification token
- [ ] Email change verification link works (in testing)
- [ ] Permissions enforced correctly
- [ ] Non-staff cannot access endpoints
- [ ] Tokens expire correctly
- [ ] Custom email sending implemented (TODO)
