# Polypsy (Quizzy)

Psychodiagnostics platform for a clinical institution. Specialists assign validated
questionnaires, patients complete them on a phone or in a browser, and the system
scores them, raises risk alerts, and keeps the clinical record around the results:
appointments, conclusions, safety plans, referrals and follow-up.

Production runs at **https://polypsy.ink**. The repository keeps its original name, Quizzy.

| Part | Stack | Path |
|---|---|---|
| API | Bun, Hono, Drizzle ORM, PostgreSQL 16 with row-level security | `apps/api` |
| Web | React 19, Vite, Tailwind v4, TanStack Query | `apps/web` |
| Mobile app | Expo SDK 57, React Native, expo-router | `apps/mobile` |
| Shared core | Types, zod schemas, scoring engine, dictionaries | `packages/shared` |

The web app has three faces, chosen by role:
- the **clinical console** for staff;
- the **patient cabinet**;
- the **tech panel** (`/ops`) for superadmins.

The mobile app serves patients and staff on rounds.

## Quick start

Requirements: [Bun](https://bun.sh), PostgreSQL 16. Recording transcription also needs
ffmpeg and whisper.cpp; everything else works without them.

```bash
createdb quizzy
cp apps/api/.env.example apps/api/.env   # set DATABASE_URL

bun install
bun run db:migrate
bun run db:seed        # demo institution, methods, patients and history
bun run api            # API on :3001
bun run web            # web on :5199
bun run mobile         # Expo on :8081, separate terminal
```

- Outside production the secrets have development defaults. Production refuses to start without them (see `apps/api/src/env.ts`).
- To point the mobile app at production, run `bun run --cwd apps/mobile start:prod`, or set `EXPO_PUBLIC_API_URL`.
- To set up a clean instance for a new institution, use `bun run install:instance` instead of the seed. It migrates the database, creates the institution and installs the method catalog.

### Demo accounts (seed only)

| Role | Email | Password |
|---|---|---|
| Superadmin | `root@quizzy.dev` | `root12345` |
| Staff | `psy@quizzy.dev` | `psy12345` |
| Staff | `psy2@quizzy.dev` | `psy212345` |
| Staff, read-only | `demo@quizzy.dev` | `demo12345` |
| Patient | `user@quizzy.dev`, `user2@quizzy.dev` | `user12345`, `user212345` |
| Patients 1–12 | `patient1@quizzy.dev` … `patient12@quizzy.dev` | `patient12345` |

### Languages

- The interface is available in Ukrainian, Russian and English.
- Method content (questions, options, band labels) is stored in Ukrainian and Russian.
- The API answers in the language from `?lang=` or `Accept-Language`, so clients receive plain strings.
- Server messages, errors and notes are stored as codes and rendered in the reader's language.
- Tests fail on hard-coded strings in the server, web or mobile code.

## Roles and permissions

- **Patient**: takes assigned methods and sees own results, appointments, messages and safety plan.
- **Staff**:
  - positions form a ladder: specialist → head of department → chief;
  - on top of their role, staff get fine-grained permissions (`patients.read`, `conclusions.sign`, `users.manage`, `ops.read`, …) and personal exceptions;
  - what a staff member sees is limited to their groups and departments.
- **Superadmin** runs the institution and the tech panel.

Rules that hold everywhere:
- Any action on another account follows one rule, whether it comes through the web, the console or a bulk action: you need the permission, the account can't be your own, it must be strictly below your position, and only a superadmin may touch a superadmin. This covers role changes, password reset, disabling or deleting an account, sessions, the second factor, signing in as another user, and roles.
- Reading a patient's clinical data goes through one check: conclusions, results, printouts and one-time print links all use it.
- The database enforces the same boundaries with row-level security under a dedicated application role. Tests run the patient and staff flows under that role.
- TOTP is the second factor. A policy makes it mandatory for superadmins and tech-panel users; other staff can turn it on themselves.
- Patients join through an invitation link. Open self-registration (`OPEN_REGISTRATION`, meant to be off in production) always creates a patient, never staff.
- Pseudonymous patient accounts store no name.

## What it does

**Assessment**
- A method constructor with a JSON view for large instruments. Edits create versions, so every result is scored by the version the patient actually saw.
- Assignment: individually, by patient group, by battery with step order, by schedule, or by cascade (a result band assigns follow-up methods).
- Patients take methods on the phone (with an offline queue) or in the browser. A clinician can fill in a method on the patient's behalf.
- Critical answers raise risk alerts on autosave, not at the end. Alerts become cases with an owner and a history.

**Clinical work**
- Reception and the day screen, appointment booking with Google Calendar / Meet links, and session recordings with local transcription.
- Conclusions with revisions and signatures, visit notes, safety plans, referrals, and dispensary follow-up with due dates.
- Messages and mailings to patients, with push notifications.
- Printouts: a result sheet, answer key sheet, blank form, visit certificate, the full outpatient chart and a case extract. The mobile app prints through a one-time link.

**Analytics**
- Patient dynamics with the reliable change index (RCI) and percentiles.
- Psychometrics: Cronbach's alpha and item-total correlations, answer-quality flags (too fast, straight-lining), and local norms.
- Cohorts, statistical models, a statistics builder, and export to CSV and SPSS with stable subject codes.

**Tech panel (`/ops`)**
- Requests, errors, logs, traces, database and slow queries, jobs, sessions, the audit log, integrity of the audit chain, and read-only SQL.
- Releases, feature flags, keys, mobile devices and push, recordings, client errors, web vitals, suspicious activity, grants, "who viewed" and second-factor status.
- Alerts go to Telegram and email.

## Scoring engine

Built both for the instruments in the manuals of the Research Center for Humanitarian Problems
of the Armed Forces of Ukraine and for international screeners. The engine lives in `packages/shared/src/scoring.ts`; the
server and the clients score the same way.

| Mechanism | Example |
|---|---|
| Key by item numbers, one item feeding several scales | SR-45, MLO, Mini-mult |
| Ratio scales (share of keyed answers) | SR-45 `Sr = N/35` |
| Scale-on-scale corrections | Mini-mult K-correction `Hs + 0.5K` |
| T-scores by sex and age, sten tables | Mini-mult, MLO |
| Validity scales that gate interpretation | lie and validity scales |
| Reversed grading, clinical recommendation per band | SR-45 |
| Clinician-administered methods | SAD PERSONS |
| Minimum answered share per scale; items hidden by display logic excluded | ASSIST, PC-PTSD-5 |

Scoring runs in a fixed order:
1. raw scores for every scale;
2. corrections, applied only after all raw scores exist;
3. normalization;
4. picking the band;
5. the validity check.

When several norms or sten rows fit a person, the most specific one wins: sex first, then age, then the narrower age range.

`validateSurvey` blocks publishing a method that cannot be scored correctly: items out of range, contradictory keys, overlapping bands, T-scores without norms, and so on. Drafts can still be saved.

### Methods

- **Shared catalog, 27 methods**: WHO-5, GAD-7, PHQ-9/8/4, PSS-10, PCL-5, AUDIT, AUDIT-C, PQ-16, Big Five, CESD-R, SRQ-20, GDS-15, DASS-42, PC-PTSD-5, CES, SBQ-R, MSPSS, OSSS-3, RSES, UCLA-3, Brief COPE, CAGE, ASSIST, ASRS-6 and CBI.
  - Installed and updated on every deploy by content fingerprint.
  - If an institution edited a method locally, its edit is kept. The `catalog-status` and `catalog-force` maintenance actions show the situation and let you override it.
- **Seed-only methods, 4**: SR-45, SAD PERSONS, Mini-mult and MLO "Adaptivnist-200".

**The methods have not been clinically validated yet.** `docs/instruments/` holds the validation package for a clinical psychologist:
- one sheet per method in Ukrainian and Russian;
- generated from the live engine, with "answers → result" examples at every band boundary;
- a test fails whenever a sheet and the engine disagree. To regenerate the sheets, run `bun run --cwd apps/api docs:instruments`.

Licensing and sources are tracked in the dossiers under `docs/instruments/dossiers/` and in `docs/INSTRUMENTS.md`.

## Data and security

- **One server, one institution.** Each institution gets its own database; there are no tenant columns.
- **Row-level security.** The app connects as `quizzy_app`, and policies limit every table.
- **Audit log.**
  - Append-only, and it records reads of patient data, not just changes.
  - Each row is chained by hash. The chain is verified on a schedule, and from the tech panel or `bun run --cwd apps/api audit:verify`.
- **Field encryption.** Names, phone numbers, free-text answers and clinical texts are encrypted with `ENCRYPTION_KEY` (`v1:<base64 32 bytes>[,v2:…]`; the first key is the active one). Phone numbers can be searched through a blind index with its own secret.
- **Separate secrets.** Session signing, the phone index, export subject codes and field encryption each have their own secret, so rotating one does not break the others.
- **Concurrency.** State changes are atomic: conclusions, referrals, mailings and safety plans check the revision the user saw and answer 409 instead of overwriting someone else's edit.

The architecture, invariants and threat model are in `docs/ARCHITECTURE.md`.

## Tests

```bash
bun run typecheck
bun run lint
bun test                                   # all unit and API tests (API tests need DATABASE_URL)
bun run --cwd apps/api test:app-role       # patient and staff flows under the application role
bun run e2e                                # Playwright on its own stand: DB quizzy_e2e, ports 3199/4199
```

- API tests recreate `<database>_test` on every run, so use your own database when running in parallel.
- CI runs test files in a different order than macOS does. Tests use unique data and never rely on "only my rows in the table".
- `migrationJournal.test.ts` walks the history since the last release and fails if a migration was added before one that already existed.

## Deploy and operations

Deploys go through GitHub Actions. A pushed `v*` tag starts `.github/workflows/deploy.yml`:
1. CI runs typecheck, lint, the API, app-role and client tests, e2e and the Docker build.
2. Images are built and pushed to GHCR.
3. The compose file and scripts are uploaded to the server and validated.
4. A database snapshot is taken.
5. The new image loads the server's environment as a pre-check. If it fails, the old version keeps running.
6. `compose up` starts `provision`. It runs the migrations, checks every migration by hash (a skipped one stops the deploy), and grants the application role its rights.
7. The shared catalog is installed, and the deploy confirms that the running version, commit and site names match the release.
8. Health checks run inside the server and from outside over HTTPS.

`.github/workflows/maintenance.yml` runs one-off actions on the server:
- catalog install, status and force;
- demo data fill and purge;
- the RLS check;
- audit chain verification;
- leftovers;
- API and web logs;
- backup status and a restore drill (also runs monthly);
- slot resync.

Backups:
- A nightly `pg_dump`, encrypted with gpg and verified by reading it back.
- Kept as 7 daily, 4 weekly and 12 monthly copies (`scripts/backup.sh`).
- A weekly timer and the monthly workflow restore the newest copy into a throwaway database and compare it with production (`scripts/verify-backup.sh`).
- Each copy is also uploaded to an S3-compatible bucket at another provider when `OFFSITE_URL` is set (`scripts/offsite.sh`); the `offsite-status` action checks that every local copy exists there.

Server setup, TLS, Google sign-in and incident handling are covered in `docs/DEPLOY.md` and `docs/RUNBOOK.md`.

## Repository map

```
apps/api/src/routes      HTTP routes, one file per area
apps/api/src/lib         domain logic: access rules, scoring glue, scheduler, notifications
apps/api/src/db          schema, RLS context, migration runner
apps/api/drizzle         SQL migrations and their journal
apps/api/src/instruments method definitions (catalog and seed)
apps/web/src/pages       console, patient cabinet and /ops screens
apps/mobile/app          expo-router screens: patient tabs, rounds, surveys, analytics
packages/shared/src      types, schemas, scoring, dictionaries (uiStrings, errorStrings, serverStrings)
scripts                  backup, restore, restore check, instance upgrade, VPS setup
e2e                      Playwright scenarios and API snapshots
docs                     architecture, deploy, runbook, roadmap, instruments
```

## Documentation

Most documents are in Russian; the validation package is in Ukrainian and Russian.

| File | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | data map, invariants, threat model |
| `docs/DEPLOY.md` | VPS installation, domain and TLS, deploys, backups, Google sign-in |
| `docs/RUNBOOK.md` | day-to-day operations and incident handling |
| `docs/instruments/` | validation package for the clinical psychologist |
| `docs/INSTRUMENTS.md` | origin and legal status of the methods (older; the validation package is current) |
| `docs/OMR.md` | feasibility of reading paper forms from a photo |
| `docs/ROADMAP.md`, `docs/REWRITE-PLAN.md`, `docs/REDESIGN.md` | plans and design migration notes (historical, not kept fully up to date) |

## Known limitations

- The methods have not been clinically validated; the validation package is waiting for a psychologist's review.
- Several instruments are copyrighted. Check their licensing in the dossiers before clinical use.
- The mobile app is not published to the App Store or Google Play; builds are run locally through Expo.
- The off-site backup copy (`scripts/offsite.sh`, any S3-compatible storage) is built but not yet configured on the production server.
- One server serves one institution. More institutions mean more instances (`scripts/upgrade-instances.sh`).
