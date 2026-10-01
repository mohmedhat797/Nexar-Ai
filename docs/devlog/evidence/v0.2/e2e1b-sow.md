I couldn't save a file because this session only has read tools and plan mode is on. The draft SOW is below. I read `docs/overview.md`, which is short. It confirms the offline logging, iOS and Android, existing REST backend, Azure AD SSO, and a "3-month" constraint.

---

# Statement of Work: Acme Field Ops (synthetic)

**Status:** DRAFT for owner review. It is not an offer and has not been sent.
**Client:** Acme Corp (synthetic)
**Draft date:** 2026-09-30

## 1. Purpose

Acme Corp (synthetic) needs a mobile app that lets field technicians log equipment inspections without network connectivity and sync them later. This SOW defines the work to deliver an offline-first inspection app for iOS and Android. The app integrates with the existing REST backend and uses Azure AD single sign-on (SSO).

## 2. Scope

The work is in scope if it can be checked against the following:

1. A mobile app for iOS and an app for Android, used by field technicians to create and complete equipment inspections.
2. Inspections can be created, edited and saved with no network connection.
3. An offline sync module uploads locally stored inspections to the existing REST backend when connectivity returns.
4. Technicians sign in through the client's Azure AD SSO.
5. An admin export of inspections (export format: TBD, see Open items).
6. Integration with the existing REST backend as it is. Any backend changes are not covered unless agreed through change control.

## 3. Deliverables

| Name | Description | Acceptance criterion |
|---|---|---|
| iOS and Android apps | Mobile apps for field technicians, with Azure AD SSO sign-in and offline inspection entry. | Each app installs on the agreed target devices and OS versions (TBD). A technician can sign in via Azure AD and create and save an inspection offline. Test cases: TBD, to be agreed. |
| Offline sync module | Stores inspections locally and syncs them to the existing REST backend when a connection is available. | Inspections created offline appear in the backend after reconnection, without loss or duplication, in the agreed test scenarios (TBD). Conflict handling rules: TBD. |
| Admin export of inspections | Lets an administrator export inspection data. | An admin can export inspections in the agreed format (TBD) and the export matches the data held in the backend for the selected records. |

## 4. Timeline

The total duration is **12 weeks** (provided by the owner). The start date and all calendar dates are TBD. The milestone structure below is a proposal and is not agreed.

| Milestone | Proposed timing | Date |
|---|---|---|
| Kickoff, access to backend and Azure AD, requirements confirmed | Weeks 1–2 (proposed) | TBD |
| Offline inspection entry and SSO working on both platforms | Weeks 3–6 (proposed) | TBD |
| Offline sync module integrated with the backend | Weeks 6–9 (proposed) | TBD |
| Admin export, testing and fixes | Weeks 9–11 (proposed) | TBD |
| Client acceptance review and handover | Week 12 (proposed) | TBD |

## 5. Roles and responsibilities

**Provider**
- Design, build and test the deliverables listed above.
- Report progress to the client. The cadence is TBD.
- Fix defects found during acceptance review, within scope.
- Name a project lead (name: TBD).

**Client (Acme Corp (synthetic))**
- Provide access to the existing REST backend, its API documentation, and test environments (details TBD).
- Provide Azure AD tenant access and configuration for SSO.
- Name a decision-maker and an acceptance reviewer (names: TBD).
- Provide feedback and review within the agreed review period.
- Make test devices and test users available (TBD).

## 6. Acceptance

- The client's named acceptance reviewer (TBD) reviews each deliverable against its acceptance criterion in section 3.
- **Review duration:** TBD. No review period was provided. Proposal for discussion: 5 working days per deliverable.
- The reviewer records acceptance or a list of defects in writing.
- The provider fixes the listed defects, and the deliverable is re-reviewed.
- The consequence if the client does not respond within the review period (for example, deemed acceptance) is not defined and needs a decision from the owner.

## 7. Assumptions

Provided:
- **[Provided]** The timeline is 12 weeks.
- **[Provided]** Target platforms are iOS and Android.
- **[Provided]** The REST backend already exists and will be reused.
- **[Provided]** Authentication uses Azure AD SSO.

Made by the drafter (to be confirmed):
- **[Assumed]** The 12-week timeline is the same as the "3-month" constraint in `docs/overview.md`.
- **[Assumed]** The backend already exposes the endpoints needed to store and retrieve inspections, so no backend development is required.
- **[Assumed]** The client provides timely access to environments and Azure AD.
- **[Assumed]** The admin export works from data in the backend and does not need a new admin interface. This is unconfirmed.
- **[Assumed]** The app is for internal Acme technicians only and is not a public store release unless agreed.

## 8. Exclusions

Not stated as in scope, so excluded unless added through change control:
- Changes or new development on the existing REST backend.
- Changes to the Azure AD tenant beyond what SSO integration needs.
- Platforms other than iOS and Android, such as web apps or tablets-specific builds.
- Ongoing support, maintenance and hosting after handover.
- Data migration from existing systems.
- End-user training.
- App store accounts, fees and publication (TBD).

## 9. Change control

1. Either party submits a written change request describing the change to scope, timeline or price.
2. The provider assesses its impact on effort, schedule and price, and returns the assessment. The response time is TBD.
3. The change takes effect only when both parties' authorised representatives (TBD) approve it in writing.
4. Work on the change does not begin until it is approved. Approved changes update this SOW.

## Open items

1. Start date and all calendar dates for the milestones.
2. Price, payment terms and commercial and legal terms. None were provided, so none are included.
3. Names of the provider project lead, client decision-maker and acceptance reviewer.
4. Review period and what happens if the client does not respond.
5. Target devices and OS versions, and the test cases for each acceptance criterion.
6. Format and fields for the admin export, and who counts as an admin.
7. Sync conflict rules, and the size of the expected data.
8. Backend API readiness and documentation, and whether any backend work is needed.
9. Confirmation that "3 months" equals 12 weeks.
10. Progress reporting cadence, and the response time for change assessments.
11. App distribution method (store or internal) and who holds the developer accounts.
12. Warranty, support after handover, and other legal terms.
