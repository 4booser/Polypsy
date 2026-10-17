# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary:** psychologists of the psychological department of a military hospital (inpatient). Patients are servicemembers. Staff work on shared machines in the department, often 13-inch laptops, in rooms with poor lighting, and move between machines during the day.
- Staff positions form a ladder: specialist → head of department → chief; what each person sees is limited by permissions, groups and departments.
- **Secondary:** patients in the web cabinet (assigned methods, own results, appointments, messages, safety plan); superadmins in the tech panel (`/ops`).

## Product Purpose

Polypsy is the department's psychodiagnostics and clinical-record system. Specialists assign validated questionnaires, patients complete them on a phone or in a browser, and the system scores them, raises risk alerts and keeps the clinical record around the results: appointments, conclusions, safety plans, referrals and follow-up. Success means the department runs its working day in it — the day screen, the queue, the patient — without losing a critical answer or a signature.

## Positioning

A scoring engine built for the instruments of the Armed Forces of Ukraine manuals (SR-45, MLO, Mini-mult and others) and for international screeners, with versioned methods (each result is scored by the version the patient actually saw), risk alerts raised on autosave rather than at the end, and one access rule enforced in the app and in the database.

## Operating Context

- The day is the unit of work: schedule, receptions, the "Today" screen, the work queue, then the patient.
- Rotations, hospitalisation and referrals (psychiatrist, inpatient, outpatient, commander) are part of the clinical story.
- Printouts go to a monochrome printer: result sheet, key sheet, blank form, visit certificate, outpatient chart, case extract.
- Personal settings (theme, density, start screen) live on the server because staff change machines.

## Capabilities and Constraints

- Three faces by role: clinical console (staff), patient cabinet, tech panel (`/ops`). The mobile client (`apps/mobile`, Expo) is a separate surface; this record covers the web app.
- Interface in Ukrainian, Russian and English; method content in Ukrainian and Russian. Ukrainian and Russian strings differ in length by up to ~15% and share one layout. All UI strings go through `packages/shared/src/uiStrings.ts`; tests fail on hard-coded strings.
- Must stay readable on a 13-inch laptop, legible in a badly lit room, printable in monochrome, and fully usable from the keyboard.
- Two themes (light by default) and a dense mode.
- Design changes do not touch queries, sorting, calculations or permissions.

## Brand Commitments

- Name: Polypsy (the repository keeps its original name, Quizzy).
- The customer supplied a mockup (palette "POLSY", violet #663399, light theme first). It is a **reference, not a binding frame**: it can be improved as long as the product stays recognisable to the customer.
- The customer previously required that after the redesign the old console should not be recognisable.

## Evidence on Hand

- Real clinical workflows and the method catalog in the seed (`bun run db:seed`) and `docs/instruments`.
- Design rationale in `apps/web/src/styles/tokens.css` comments and `docs/REDESIGN.md`.
- No testimonials, case studies or usage metrics are on hand; do not invent them.

## Product Principles

1. Attention is scarce: a signal colour means "needs attention" and nothing else.
2. Data over decoration: numbers lead, space goes to content, not to chrome.
3. Nothing critical is lost: a risk answer, an unsigned conclusion or an overdue follow-up is always findable.
4. The same rule everywhere: access, scoring and wording behave the same in every place they appear.

## Accessibility & Inclusion

- Text contrast ≥ 4.5:1 in both themes; colour never carries meaning alone (severity always has a label and a marker shape).
- Chart palette distinguishable under protanopia, deuteranopia and tritanopia.
- Full keyboard operation; usable at 13-inch widths without horizontal page scroll.
