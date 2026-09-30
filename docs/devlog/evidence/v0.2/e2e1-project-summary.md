# Acme Field Ops: Project Summary

## Goal
Give Acme's field technicians a mobile app for logging equipment inspections while offline, then syncing the data once connectivity returns.

## Scope
- **In scope:**
  - A mobile app for field technicians.
  - Offline capture of equipment inspections.
  - Deferred sync to the existing backend.
  - Both iOS and Android.
  - Sign-in through Azure AD SSO.
- **Not specified:** The overview doesn't list inspection fields, reporting, photo or attachment capture, or admin features. Treat these as out of scope until someone confirms them.

## Constraints
- **Timeline:** 3 months.
- **Platforms:** iOS and Android.
- **Backend:** Must use the existing REST backend.
- **Authentication:** SSO via Azure AD.

## Risks
The overview states only the constraints above. These risks are my inferences from them, not items the document lists.
- **Schedule:** Two platforms, offline support and SSO in 3 months leaves little slack. A cross-platform framework might reduce the risk.
- **Sync and conflicts:** Offline-first sync can produce conflicting edits, duplicate records and partial uploads. The existing REST API may not be designed for batch or idempotent writes.
- **Offline authentication:** Azure AD tokens expire. Behavior while offline, and on re-login after a long offline period, needs defining.
- **Backend dependency:** API gaps or changes would block the app, because the app can't change the backend.
- **Unclear requirements:** The overview is brief. The data model, volume and device types are undefined, so scope could grow.