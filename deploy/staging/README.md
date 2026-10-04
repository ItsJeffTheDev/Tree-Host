# Staging site on Firebase / Google Cloud Run

The staging site is the real Tree Host with `TREEHOST_STAGING=1`: every page, sign-up, sign-in, the dashboard, the
Staff Console and staff invite links work, but nobody can create servers or buy plans. A "Staging site" pill shows
on every page.

It runs on **Cloud Run** in the same Google project as Firebase (`tree-host`), and keeps its accounts in the Firebase
Realtime Database under its own area, `treehost-staging`, so staging accounts never mix with real customers.

> **Why not Firebase Hosting in front?** Firebase Hosting only passes one cookie (`__session`) to the server, and Tree
> Host's sign-in uses its own cookies, so sign-in would break. Point the domain straight at Cloud Run instead (below).

## One-time setup

1. The Firebase project must be on the **Blaze** (pay as you go) plan to use Cloud Run. A single small staging
   instance usually costs a few dollars a month; set a budget alert in Google Cloud Billing.
2. Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), then:

       gcloud auth login
       gcloud config set project tree-host
       gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

3. Store the Firebase service account key as a secret (the same JSON file Start.bat uses; never commit it):

       gcloud secrets create firebase-sa --data-file=tree-host-firebase.json

4. Let Cloud Run read it:

       gcloud secrets add-iam-policy-binding firebase-sa --member="serviceAccount:$(gcloud projects describe tree-host --format='value(projectNumber)')-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor

5. In the Firebase console: **Authentication > Settings > Authorized domains**, add the staging domain
   (for example `staging.treehost.online`) and the `*.run.app` address Cloud Run gives you. Without this, sign-in and
   Google sign-in fail on staging.

## Deploy (and every update)

From the repo folder (replace the address with the one people will use):

    gcloud run deploy tree-host-staging --source . --region us-central1 --allow-unauthenticated ^
      --min-instances 1 --max-instances 1 --memory 512Mi --no-cpu-throttling ^
      --set-secrets "/secrets/firebase.json=firebase-sa:latest" ^
      --set-env-vars "TREEHOST_STAGING=1,TREEHOST_PUBLIC_URL=https://staging.treehost.online,FIREBASE_SERVICE_ACCOUNT_FILE=/secrets/firebase.json,FIREBASE_DB_ROOT=treehost-staging,TREEHOST_ADMIN_EMAILS=daniel@treehost.online,FIREBASE_API_KEY=REDACTED,FIREBASE_AUTH_DOMAIN=tree-host.firebaseapp.com,FIREBASE_PROJECT_ID=tree-host,FIREBASE_DATABASE_URL=https://tree-host-default-rtdb.firebaseio.com,FIREBASE_APP_ID=1:840029330018:web:96c8dbdde3990b3fdccf3b"

(`^` continues the line in Windows cmd; use `\` in bash.) **Exactly one instance** (`--min-instances 1
--max-instances 1`) matters: Tree Host keeps sessions in memory and saves to the database, so two copies would
disagree. Optional extras: `RESEND_API_KEY` for emails (use `--set-secrets` for it too), `TREEHOST_DISCORD_INVITE`.

## The domain

    gcloud beta run domain-mappings create --service tree-host-staging --domain staging.treehost.online --region us-central1

It prints DNS records to add at Namecheap. HTTPS is set up automatically (it can take up to an hour). Domain mappings
work in regions such as us-central1; if yours doesn't support them, use a Google Cloud load balancer instead.

## Who is Owner

Sign up on staging with **daniel@treehost.online** (verified email or Google sign-in) to get the Owner role, then
invite staff from **Staff Console > People > Invite link**. Links go to `https://<staging>/dashboard?invite=...`.
